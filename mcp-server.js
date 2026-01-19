import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import z from "zod";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// State - just the loaded AST data
let astData = null;
let repoPath = null;

const server = new McpServer({
  name: "swift-impact-analyzer",
  version: "3.0.0",
});

// ============== HELPERS ==============

async function findSwiftFiles(dir) {
  const swiftFiles = [];
  const skip = ['Pods', '.build', 'build', 'DerivedData', '.git', 'Carthage', 'node_modules'];
  
  async function scan(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && !skip.includes(entry.name)) {
        await scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.swift')) {
        swiftFiles.push(fullPath);
      }
    }
  }
  
  await scan(dir);
  return swiftFiles;
}

function extractSymbols(ast, filePath) {
  const symbols = { classes: [], structs: [], protocols: [], functions: [], enums: [], extensions: [], variables: [] };
  
  function walk(node) {
    if (!node) return;
    const kind = node['key.kind'];
    const name = node['key.name'];
    
    if (kind && name) {
      const info = {
        name,
        kind,
        file: filePath,
        inheritedTypes: node['key.inheritedtypes']?.map(t => t['key.name']) || [],
        accessibility: node['key.accessibility']?.replace('source.lang.swift.accessibility.', ''),
        typeName: node['key.typename'],
        offset: node['key.offset'],
        length: node['key.length'],
      };
      
      if (kind.includes('class')) symbols.classes.push(info);
      else if (kind.includes('struct')) symbols.structs.push(info);
      else if (kind.includes('protocol')) symbols.protocols.push(info);
      else if (kind.includes('enum')) symbols.enums.push(info);
      else if (kind.includes('extension')) symbols.extensions.push({ ...info, extendedType: name });
      else if (kind.includes('function') || kind.includes('method')) symbols.functions.push(info);
      else if (kind.includes('var')) symbols.variables.push(info);
    }
    
    for (const child of node['key.substructure'] || []) {
      walk(child);
    }
  }
  
  walk(ast);
  return symbols;
}

function extractMemberData(ast, symbols) {
  const memberData = {};
  
  function findAndExtractMembers(node, symbolName) {
    if (!node) return null;
    const kind = node['key.kind'];
    const name = node['key.name'];
    
    // Check if this node matches any of our symbols
    if (kind && name && symbolName === name) {
      const members = { properties: [], methods: [], initializers: [] };
      
      for (const m of node['key.substructure'] || []) {
        const memberKind = m['key.kind'] || '';
        const memberName = m['key.name'] || '';
        const type = m['key.typename'];
        const access = m['key.accessibility']?.replace('source.lang.swift.accessibility.', '');
        
        if (memberKind.includes('function') || memberKind.includes('method')) {
          if (memberName.startsWith('init')) {
            members.initializers.push({ name: memberName, access });
          } else {
            members.methods.push({ name: memberName, returnType: type, access });
          }
        } else if (memberKind.includes('var')) {
          members.properties.push({ name: memberName, type, access });
        }
      }
      
      return members;
    }
    
    // Recursively search children
    for (const child of node['key.substructure'] || []) {
      const result = findAndExtractMembers(child, symbolName);
      if (result) return result;
    }
    
    return null;
  }
  
  // Extract members for all symbols
  const allSymbols = [
    ...symbols.classes,
    ...symbols.structs,
    ...symbols.protocols,
    ...symbols.enums
  ];
  
  for (const symbol of allSymbols) {
    const members = findAndExtractMembers(ast, symbol.name);
    if (members) {
      memberData[symbol.name] = members;
    }
  }
  
  return memberData;
}

function getRelativePath(fullPath) {
  return repoPath ? fullPath.replace(repoPath + '/', '') : fullPath;
}

// Helper to get plural form of symbol kind
const kindToPlural = {
  'class': 'classes',
  'struct': 'structs',
  'protocol': 'protocols',
  'enum': 'enums',
  'function': 'functions'
};

function findSymbol(symbolName) {
  if (!astData) return null;
  
  // Use index for O(1) lookup instead of O(n) search
  const indexMatches = astData.indexes?.byName?.[symbolName];
  if (indexMatches && indexMatches.length > 0) {
    const match = indexMatches[0];
    const fullPath = path.join(repoPath, match.file);
    const fileData = astData.files?.[fullPath];
    if (fileData) {
      const pluralKind = kindToPlural[match.kind] || `${match.kind}s`;
      const symbolList = fileData.symbols?.[pluralKind];
      if (symbolList) {
        const symbol = symbolList.find(s => s.name === symbolName);
        if (symbol) {
          return { ...symbol, file: match.file, symbolKind: match.kind };
        }
      }
    }
  }
  
  // Fallback to type map
  const typeInfo = astData.dependencyGraph?.typeMap?.[symbolName];
  if (typeInfo) {
    return { ...typeInfo.symbol, file: typeInfo.file, symbolKind: typeInfo.kind };
  }
  
  return null;
}

// ============== HELPER: DETECT PROJECT TYPE ==============

async function detectProjectType(projectPath) {
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  
  let xcworkspace = null;
  let xcodeproj = null;
  
  for (const entry of entries) {
    if (entry.name.endsWith('.xcworkspace') && entry.isDirectory()) {
      xcworkspace = path.join(projectPath, entry.name);
    } else if (entry.name.endsWith('.xcodeproj') && entry.isDirectory()) {
      xcodeproj = path.join(projectPath, entry.name);
    }
  }
  
  // xcworkspace takes priority (may include Pods/SPM)
  if (xcworkspace) {
    return { type: 'xcworkspace', path: xcworkspace, name: path.basename(xcworkspace, '.xcworkspace') };
  }
  if (xcodeproj) {
    return { type: 'xcodeproj', path: xcodeproj, name: path.basename(xcodeproj, '.xcodeproj') };
  }
  
  return null;
}

// ============== TOOL 1: INIT ==============

server.registerTool(
  "init_swift_repo",
  {
    title: "Initialize Swift Repository",
    description: "Scans a Swift/iOS project and generates AST using SourceKitten. Requires .xcodeproj or .xcworkspace. Run this first.",
    inputSchema: {
      repoPath: z.string().describe("Absolute path to the Swift/iOS project folder."),
    },
  },
  async ({ repoPath: inputPath }) => {
    try {
      // Validate directory
      const stats = await fs.stat(inputPath);
      if (!stats.isDirectory()) {
        return { content: [{ type: "text", text: `❌ "${inputPath}" is not a directory.` }] };
      }
      
      // Check for iOS project (xcodeproj or xcworkspace)
      const projectInfo = await detectProjectType(inputPath);
      if (!projectInfo) {
        return { content: [{ type: "text", text: `❌ Not an iOS/Swift project.

No .xcodeproj or .xcworkspace found in:
${inputPath}

This tool only works with iOS/macOS Xcode projects.
Aborting analysis.` }] };
      }
      
      // Check sourcekitten
      try {
        await execAsync('which sourcekitten');
      } catch {
        return { content: [{ type: "text", text: `❌ SourceKitten not found. Install: brew install sourcekitten` }] };
      }
      
      repoPath = inputPath;
      const swiftFiles = await findSwiftFiles(repoPath);
      
      if (swiftFiles.length === 0) {
        return { content: [{ type: "text", text: `❌ No Swift files found in iOS project.

Project: ${projectInfo.name} (${projectInfo.type})
Path: ${projectInfo.path}

The project exists but contains no .swift files.
Aborting analysis.` }] };
      }
      
      // Generate AST for each file
      const files = {};
      let processed = 0, errors = 0;
      
      for (const file of swiftFiles) {
        try {
          const { stdout } = await execAsync(`sourcekitten structure --file "${file}"`);
          const ast = JSON.parse(stdout);
          const symbols = extractSymbols(ast, file);
          const memberData = extractMemberData(ast, symbols);
          files[file] = { symbols, memberData };
          processed++;
        } catch {
          errors++;
        }
      }
      
      // Build type map
      const typeMap = {};
      for (const [filePath, fileData] of Object.entries(files)) {
        const rel = getRelativePath(filePath);
        for (const c of fileData.symbols.classes) typeMap[c.name] = { file: rel, kind: 'class', symbol: c };
        for (const s of fileData.symbols.structs) typeMap[s.name] = { file: rel, kind: 'struct', symbol: s };
        for (const p of fileData.symbols.protocols) typeMap[p.name] = { file: rel, kind: 'protocol', symbol: p };
        for (const e of fileData.symbols.enums) typeMap[e.name] = { file: rel, kind: 'enum', symbol: e };
      }
      
      // Build edges
      const edges = [];
      for (const [filePath, fileData] of Object.entries(files)) {
        const rel = getRelativePath(filePath);
        const allTypes = [...fileData.symbols.classes, ...fileData.symbols.structs, ...fileData.symbols.enums, ...fileData.symbols.extensions];
        for (const symbol of allTypes) {
          for (const inherited of symbol.inheritedTypes || []) {
            if (typeMap[inherited]) {
              edges.push({ from: rel, to: typeMap[inherited].file, fromSymbol: symbol.name, toSymbol: inherited });
            }
          }
        }
      }
      
      // Build search indexes for faster queries
      const indexes = {
        byName: {},      // symbolName -> [{ file, kind }]
        byKind: {},      // 'class' -> [symbolNames]
        byFile: {}       // filePath -> [symbolNames]
      };

      for (const [filePath, fileData] of Object.entries(files)) {
        const rel = getRelativePath(filePath);
        indexes.byFile[rel] = [];
        
        const processSymbols = (symbols, kind) => {
          if (!indexes.byKind[kind]) indexes.byKind[kind] = [];
          
          for (const symbol of symbols) {
            // Index by name
            if (!indexes.byName[symbol.name]) indexes.byName[symbol.name] = [];
            indexes.byName[symbol.name].push({ file: rel, kind });
            
            // Index by kind
            indexes.byKind[kind].push(symbol.name);
            
            // Index by file
            indexes.byFile[rel].push(symbol.name);
          }
        };
        
        processSymbols(fileData.symbols.classes, 'class');
        processSymbols(fileData.symbols.structs, 'struct');
        processSymbols(fileData.symbols.protocols, 'protocol');
        processSymbols(fileData.symbols.enums, 'enum');
        processSymbols(fileData.symbols.functions, 'function');
      }
      
      astData = {
        repoPath,
        generatedAt: new Date().toISOString(),
        files,
        dependencyGraph: { typeMap, edges },
        indexes
      };
      
      // Save
      const outputPath = path.join(repoPath, "app.json");
      await fs.writeFile(outputPath, JSON.stringify(astData, null, 2));
      
      // Count totals
      let classes = 0, structs = 0, protocols = 0, enums = 0, functions = 0;
      for (const f of Object.values(files)) {
        classes += f.symbols.classes.length;
        structs += f.symbols.structs.length;
        protocols += f.symbols.protocols.length;
        enums += f.symbols.enums.length;
        functions += f.symbols.functions.length;
      }
      
      return { content: [{ type: "text", text: `✅ Initialized: ${repoPath}

� Project: ${projectInfo.name} (${projectInfo.type})
�📊 ${swiftFiles.length} files (${processed} OK, ${errors} errors)
   Classes: ${classes} | Structs: ${structs} | Protocols: ${protocols} | Enums: ${enums} | Functions: ${functions}
   
📄 Saved to: ${outputPath}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error: ${error.message}` }] };
    }
  }
);

// ============== TOOL 2: LOAD ==============

server.registerTool(
  "load_ast",
  {
    title: "Load AST",
    description: "Load a previously generated app.json file.",
    inputSchema: {
      astPath: z.string().describe("Path to the app.json file."),
    },
  },
  async ({ astPath }) => {
    try {
      const content = await fs.readFile(astPath, "utf-8");
      astData = JSON.parse(content);
      repoPath = astData.repoPath;
      
      return { content: [{ type: "text", text: `✅ Loaded: ${astPath}
📂 Repo: ${repoPath}
📁 Files: ${Object.keys(astData.files || {}).length}
🔗 Types: ${Object.keys(astData.dependencyGraph?.typeMap || {}).length}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `❌ Error: ${error.message}` }] };
    }
  }
);

// ============== TOOL 3: EXPLAIN (main tool) ==============

server.registerTool(
  "explain_symbol",
  {
    title: "Explain Symbol",
    description: "Explains how a class, struct, protocol, enum, or function works and is used. This is the main analysis tool.",
    inputSchema: {
      symbolName: z.string().describe("Name of the symbol to explain."),
    },
  },
  async ({ symbolName }) => {
    if (!astData) {
      return { content: [{ type: "text", text: "❌ No AST loaded. Run init_swift_repo or load_ast first." }] };
    }
    
    const symbol = findSymbol(symbolName);
    if (!symbol) {
      return { content: [{ type: "text", text: `❌ Symbol "${symbolName}" not found.` }] };
    }
    
    // Get pre-extracted members
    const fullPath = path.join(repoPath, symbol.file);
    const fileData = astData.files?.[fullPath];
    const members = fileData?.memberData?.[symbolName] || { properties: [], methods: [], initializers: [] };
    
    // Find usages
    const inheritedBy = (astData.dependencyGraph?.edges || [])
      .filter(e => e.toSymbol === symbolName)
      .map(e => ({ name: e.fromSymbol, file: e.from }));
    
    const extensions = [];
    const referencedIn = [];
    
    // Quick check: files that contain a symbol with this exact name (using index)
    const filesWithSymbol = new Set();
    const symbolLocations = astData.indexes?.byName?.[symbolName] || [];
    for (const loc of symbolLocations) {
      if (loc.file !== symbol.file) {
        filesWithSymbol.add(loc.file);
      }
    }
    
    for (const [filePath, fd] of Object.entries(astData.files || {})) {
      const rel = getRelativePath(filePath);
      if (rel === symbol.file) continue;
      
      // Extensions
      for (const ext of fd.symbols?.extensions || []) {
        if (ext.name === symbolName) {
          extensions.push({ file: rel, conformances: ext.inheritedTypes || [] });
        }
      }
      
      // References: Check if file uses this symbol (as type or inheritance)
      const usesSymbol = 
        filesWithSymbol.has(rel) ||  // Has a symbol with exact same name (from index)
        Object.values(fd.symbols || {}).some(symbolList => 
          symbolList.some(s => 
            s.typeName === symbolName ||
            s.inheritedTypes?.includes(symbolName)
          )
        );

      if (usesSymbol) referencedIn.push(rel);
    }
    
    // Build response
    let r = `📖 ${symbolName}\n${'━'.repeat(40)}\n\n`;
    r += `📍 ${symbol.symbolKind} in ${symbol.file}\n`;
    r += `🔒 ${symbol.accessibility || 'internal'}\n`;
    
    if (symbol.inheritedTypes?.length > 0) {
      r += `\n📎 Inherits/Conforms to:\n`;
      for (const t of symbol.inheritedTypes) {
        const info = astData.dependencyGraph?.typeMap?.[t];
        r += `   • ${t}${info ? ` (${info.kind} in ${info.file})` : ' (external)'}\n`;
      }
    }
    
    if (members.properties.length > 0) {
      r += `\n📝 Properties (${members.properties.length}):\n`;
      for (const p of members.properties.slice(0, 10)) {
        r += `   • ${p.name}${p.type ? `: ${p.type}` : ''}${p.access && p.access !== 'internal' ? ` [${p.access}]` : ''}\n`;
      }
      if (members.properties.length > 10) r += `   ... +${members.properties.length - 10} more\n`;
    }
    
    if (members.initializers.length > 0) {
      r += `\n🔨 Initializers (${members.initializers.length}):\n`;
      for (const i of members.initializers) {
        r += `   • ${i.name}${i.access && i.access !== 'internal' ? ` [${i.access}]` : ''}\n`;
      }
    }
    
    if (members.methods.length > 0) {
      r += `\n⚡ Methods (${members.methods.length}):\n`;
      for (const m of members.methods.slice(0, 10)) {
        r += `   • ${m.name}${m.returnType ? ` → ${m.returnType}` : ''}${m.access && m.access !== 'internal' ? ` [${m.access}]` : ''}\n`;
      }
      if (members.methods.length > 10) r += `   ... +${members.methods.length - 10} more\n`;
    }
    
    r += `\n🔗 Usage:\n`;
    if (inheritedBy.length > 0) {
      r += `   Inherited by: ${inheritedBy.map(x => x.name).join(', ')}\n`;
    }
    if (extensions.length > 0) {
      r += `   Extended in: ${extensions.map(x => x.file).join(', ')}\n`;
    }
    if (referencedIn.length > 0) {
      r += `   Referenced in: ${referencedIn.slice(0, 5).join(', ')}${referencedIn.length > 5 ? ` +${referencedIn.length - 5} more` : ''}\n`;
    }
    if (inheritedBy.length === 0 && extensions.length === 0 && referencedIn.length === 0) {
      r += `   ⚠️ No usages found (may be entry point or use composition)\n`;
    }
    
    return { content: [{ type: "text", text: r }] };
  }
);

// ============== TOOL 4: SEARCH ==============

server.registerTool(
  "search_symbols",
  {
    title: "Search Symbols",
    description: "Search for classes, structs, protocols, functions, or enums by name.",
    inputSchema: {
      query: z.string().describe("Search query (partial match)."),
      type: z.enum(["all", "class", "struct", "protocol", "function", "enum"]).optional().describe("Filter by type."),
    },
  },
  async ({ query, type = "all" }) => {
    if (!astData) {
      return { content: [{ type: "text", text: "❌ No AST loaded." }] };
    }
    
    const results = [];
    const q = query.toLowerCase();
    
    for (const [filePath, fileData] of Object.entries(astData.files || {})) {
      const rel = getRelativePath(filePath);
      const add = (symbols, kind) => {
        for (const s of symbols || []) {
          if (s.name?.toLowerCase().includes(q)) {
            results.push({ name: s.name, kind, file: rel, inherited: s.inheritedTypes });
          }
        }
      };
      
      if (type === "all" || type === "class") add(fileData.symbols?.classes, "class");
      if (type === "all" || type === "struct") add(fileData.symbols?.structs, "struct");
      if (type === "all" || type === "protocol") add(fileData.symbols?.protocols, "protocol");
      if (type === "all" || type === "function") add(fileData.symbols?.functions, "function");
      if (type === "all" || type === "enum") add(fileData.symbols?.enums, "enum");
    }
    
    if (results.length === 0) {
      return { content: [{ type: "text", text: `🔍 No results for "${query}"` }] };
    }
    
    let r = `🔍 Found ${results.length} results for "${query}"\n\n`;
    for (const item of results.slice(0, 25)) {
      r += `• ${item.name} (${item.kind})`;
      if (item.inherited?.length > 0) r += ` : ${item.inherited.join(', ')}`;
      r += `\n  └─ ${item.file}\n`;
    }
    if (results.length > 25) r += `\n... +${results.length - 25} more`;
    
    return { content: [{ type: "text", text: r }] };
  }
);

// ============== TOOL 5: STATS ==============

server.registerTool(
  "get_codebase_stats",
  {
    title: "Codebase Statistics",
    description: "Get an overview of the codebase.",
    inputSchema: {},
  },
  async () => {
    if (!astData) {
      return { content: [{ type: "text", text: "❌ No AST loaded." }] };
    }
    
    let classes = 0, structs = 0, protocols = 0, enums = 0, functions = 0, extensions = 0;
    const fileSizes = [];
    
    for (const [filePath, fileData] of Object.entries(astData.files || {})) {
      const s = fileData.symbols;
      classes += s.classes?.length || 0;
      structs += s.structs?.length || 0;
      protocols += s.protocols?.length || 0;
      enums += s.enums?.length || 0;
      functions += s.functions?.length || 0;
      extensions += s.extensions?.length || 0;
      
      const total = (s.classes?.length || 0) + (s.structs?.length || 0) + (s.protocols?.length || 0) + 
                   (s.enums?.length || 0) + (s.functions?.length || 0);
      fileSizes.push({ file: getRelativePath(filePath), count: total });
    }
    
    fileSizes.sort((a, b) => b.count - a.count);
    
    const fileCount = Object.keys(astData.files).length;
    const total = classes + structs + protocols + enums;
    
    let r = `📊 Codebase Statistics\n${'━'.repeat(40)}\n\n`;
    r += `📁 ${fileCount} Swift files\n\n`;
    r += `📦 Types: ${total}\n`;
    r += `   Classes:    ${classes}\n`;
    r += `   Structs:    ${structs}\n`;
    r += `   Protocols:  ${protocols}\n`;
    r += `   Enums:      ${enums}\n`;
    r += `   Extensions: ${extensions}\n`;
    r += `   Functions:  ${functions}\n\n`;
    r += `📄 Largest files:\n`;
    for (const f of fileSizes.slice(0, 5)) {
      r += `   ${f.count.toString().padStart(3)} symbols → ${f.file}\n`;
    }
    
    return { content: [{ type: "text", text: r }] };
  }
);

// ============== TOOL 6: FILE OVERVIEW ==============

server.registerTool(
  "get_file_overview",
  {
    title: "File Overview",
    description: "Get overview of a specific Swift file.",
    inputSchema: {
      filePath: z.string().describe("File path (partial match supported)."),
    },
  },
  async ({ filePath: input }) => {
    if (!astData) {
      return { content: [{ type: "text", text: "❌ No AST loaded." }] };
    }
    
    // Find file
    const matches = Object.keys(astData.files).filter(f => f.toLowerCase().includes(input.toLowerCase()));
    
    if (matches.length === 0) {
      return { content: [{ type: "text", text: `❌ No file matching "${input}"` }] };
    }
    if (matches.length > 1) {
      return { content: [{ type: "text", text: `❌ Multiple matches:\n${matches.map(f => `• ${getRelativePath(f)}`).join('\n')}` }] };
    }
    
    const fullPath = matches[0];
    const fileData = astData.files[fullPath];
    const s = fileData.symbols;
    
    let r = `📄 ${getRelativePath(fullPath)}\n${'━'.repeat(40)}\n\n`;
    
    const sections = [
      { name: 'Classes', items: s.classes },
      { name: 'Structs', items: s.structs },
      { name: 'Protocols', items: s.protocols },
      { name: 'Enums', items: s.enums },
      { name: 'Extensions', items: s.extensions },
      { name: 'Functions', items: s.functions },
    ];
    
    for (const sec of sections) {
      if (sec.items?.length > 0) {
        r += `${sec.name} (${sec.items.length}):\n`;
        for (const item of sec.items.slice(0, 10)) {
          r += `  • ${item.name}`;
          if (item.inheritedTypes?.length > 0) r += ` : ${item.inheritedTypes.join(', ')}`;
          if (item.typeName) r += ` → ${item.typeName}`;
          r += '\n';
        }
        if (sec.items.length > 10) r += `  ... +${sec.items.length - 10} more\n`;
        r += '\n';
      }
    }
    
    return { content: [{ type: "text", text: r }] };
  }
);

// ============== START SERVER ==============

const transport = new StdioServerTransport();
await server.connect(transport);
