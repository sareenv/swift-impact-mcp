import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import z from "zod";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

// Constants for Clang AST generation
const CLANG_NULL_POINTER = '0x0';  // Clang's JSON AST representation for null pointer
const CLANG_AST_ARGS = ['-x', 'objective-c', '-Xclang', '-ast-dump=json', '-fsyntax-only', '-fno-color-diagnostics'];

// Display limits for output formatting
const MAX_DISPLAY_PROPERTIES = 10;
const MAX_DISPLAY_METHODS = 10;
const MAX_DISPLAY_FILES = 5;
const MAX_SEARCH_RESULTS = 25;
const PROGRESS_UPDATE_INTERVAL = 10;  // Log progress every N files

// Helper to safely calculate length from Clang AST range
function calculateRangeLength(range) {
  // Check for null/undefined, but allow 0 as a valid offset
  if (range?.begin?.offset === null || range?.begin?.offset === undefined ||
      range?.end?.offset === null || range?.end?.offset === undefined) {
    return undefined;
  }
  return range.end.offset - range.begin.offset;
}

// Helper to safely execute commands with file paths
async function execWithFile(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
    
    child.on('error', reject);
  });
}

// State - just the loaded AST data
let astData = null;
let repoPath = null;

const server = new McpServer({
  name: "swift-impact-analyzer",
  version: "3.0.0",
});

// ============== HELPERS ==============

async function findSourceFiles(dir) {
  const sourceFiles = { swift: [], objc: [] };
  const skip = ['Pods', '.build', 'build', 'DerivedData', '.git', 'Carthage', 'node_modules'];
  
  async function scan(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && !skip.includes(entry.name)) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.swift')) {
          sourceFiles.swift.push(fullPath);
        } else if (entry.name.endsWith('.m') || entry.name.endsWith('.h')) {
          sourceFiles.objc.push(fullPath);
        }
      }
    }
  }
  
  await scan(dir);
  return sourceFiles;
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

function extractObjCSymbols(ast, filePath) {
  const symbols = { classes: [], structs: [], protocols: [], functions: [], enums: [], extensions: [], variables: [] };
  const memberData = {};
  
  function walk(node) {
    if (!node) return;
    const kind = node.kind;
    const name = node.name;
    
    // Handle Objective-C classes
    if (kind === 'ObjCInterfaceDecl' && name && !node.isImplicit) {
      const info = {
        name,
        kind: 'source.lang.objc.decl.class',
        file: filePath,
        inheritedTypes: [],
        accessibility: filePath.endsWith('.h') ? 'public' : 'internal',
        offset: node.loc?.offset,
        length: calculateRangeLength(node.range),
      };
      
      // Extract superclass (if present)
      // Note: Clang uses '0x0' to indicate a null pointer, meaning no superclass exists
      if (node.super && node.super.id !== CLANG_NULL_POINTER) {
        const superName = node.super.name;
        if (superName) {
          info.inheritedTypes.push(superName);
        }
      }
      
      // Extract protocols
      if (node.protocols) {
        for (const protocol of node.protocols) {
          if (protocol.name) {
            info.inheritedTypes.push(protocol.name);
          }
        }
      }
      
      symbols.classes.push(info);
      
      // Extract members
      const members = { properties: [], methods: [], initializers: [] };
      for (const child of node.inner || []) {
        if (child.kind === 'ObjCMethodDecl' && child.name) {
          const methodInfo = {
            name: child.name,
            returnType: child.returnType?.qualType,
            access: info.accessibility,
          };
          // Objective-C initializers are methods that start with 'init' (init, initWith..., etc.)
          // but only if they return 'instancetype' or the class type (id in parsed form)
          if (child.name === 'init' || child.name.startsWith('initWith')) {
            members.initializers.push(methodInfo);
          } else {
            members.methods.push(methodInfo);
          }
        } else if (child.kind === 'ObjCPropertyDecl' && child.name) {
          members.properties.push({
            name: child.name,
            type: child.type?.qualType,
            access: info.accessibility,
          });
        }
      }
      memberData[name] = members;
    }
    
    // Handle Objective-C protocols
    if (kind === 'ObjCProtocolDecl' && name && !node.isImplicit) {
      const info = {
        name,
        kind: 'source.lang.objc.decl.protocol',
        file: filePath,
        inheritedTypes: [],
        accessibility: filePath.endsWith('.h') ? 'public' : 'internal',
        offset: node.loc?.offset,
        length: calculateRangeLength(node.range),
      };
      
      // Extract inherited protocols
      if (node.protocols) {
        for (const protocol of node.protocols) {
          if (protocol.name) {
            info.inheritedTypes.push(protocol.name);
          }
        }
      }
      
      symbols.protocols.push(info);
      
      // Extract methods from protocol
      const members = { properties: [], methods: [], initializers: [] };
      for (const child of node.inner || []) {
        if (child.kind === 'ObjCMethodDecl' && child.name) {
          members.methods.push({
            name: child.name,
            returnType: child.returnType?.qualType,
            access: info.accessibility,
          });
        } else if (child.kind === 'ObjCPropertyDecl' && child.name) {
          members.properties.push({
            name: child.name,
            type: child.type?.qualType,
            access: info.accessibility,
          });
        }
      }
      memberData[name] = members;
    }
    
    // Handle Objective-C categories
    if (kind === 'ObjCCategoryDecl' && name && !node.isImplicit) {
      // Categories should always have an interface, but handle gracefully if missing
      const interfaceName = node.interface?.name;
      if (!interfaceName) {
        // Skip categories without a valid interface as they're malformed
        return;
      }
      
      const categoryName = `${interfaceName}(${name})`;
      const info = {
        name: categoryName,
        kind: 'source.lang.objc.decl.extension',
        file: filePath,
        inheritedTypes: [],
        accessibility: filePath.endsWith('.h') ? 'public' : 'internal',
        offset: node.loc?.offset,
        length: calculateRangeLength(node.range),
        extendedType: interfaceName,
      };
      
      // Extract protocols adopted by category
      if (node.protocols) {
        for (const protocol of node.protocols) {
          if (protocol.name) {
            info.inheritedTypes.push(protocol.name);
          }
        }
      }
      
      symbols.extensions.push(info);
    }
    
    // Recursively process children
    for (const child of node.inner || []) {
      walk(child);
    }
  }
  
  walk(ast);
  return { symbols, memberData };
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
    description: "Scans a Swift/iOS project and generates AST using SourceKitten and Clang. Processes both Swift and Objective-C files. Requires .xcodeproj or .xcworkspace. Run this first.",
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
        await execWithFile('which', ['sourcekitten']);
      } catch {
        return { content: [{ type: "text", text: `❌ SourceKitten not found. Install: brew install sourcekitten` }] };
      }
      
      // Check clang
      let clangAvailable = true;
      try {
        await execWithFile('which', ['clang']);
      } catch {
        clangAvailable = false;
      }
      
      repoPath = inputPath;
      const sourceFiles = await findSourceFiles(repoPath);
      
      if (sourceFiles.swift.length === 0 && sourceFiles.objc.length === 0) {
        return { content: [{ type: "text", text: `❌ No Swift or Objective-C files found in iOS project.

Project: ${projectInfo.name} (${projectInfo.type})
Path: ${projectInfo.path}

The project exists but contains no .swift, .m, or .h files.
Aborting analysis.` }] };
      }
      
      // Generate AST for each file
      const files = {};
      let swiftProcessed = 0, swiftErrors = 0;
      let objcProcessed = 0, objcErrors = 0;
      const errorDetails = [];
      
      // Process Swift files
      for (let i = 0; i < sourceFiles.swift.length; i++) {
        const file = sourceFiles.swift[i];
        try {
          // Log progress periodically
          if (i > 0 && i % PROGRESS_UPDATE_INTERVAL === 0) {
            console.error(`[Progress] Swift: ${i}/${sourceFiles.swift.length} files processed`);
          }
          
          const { stdout } = await execWithFile('sourcekitten', ['structure', '--file', file]);
          const ast = JSON.parse(stdout);
          const symbols = extractSymbols(ast, file);
          const memberData = extractMemberData(ast, symbols);
          files[file] = { symbols, memberData, language: 'swift' };
          swiftProcessed++;
        } catch (error) {
          swiftErrors++;
          errorDetails.push({ 
            file: getRelativePath(file), 
            language: 'swift',
            error: error.message 
          });
        }
      }
      
      // Process Objective-C files
      if (clangAvailable && sourceFiles.objc.length > 0) {
        for (let i = 0; i < sourceFiles.objc.length; i++) {
          const file = sourceFiles.objc[i];
          try {
            // Log progress periodically
            if (i > 0 && i % PROGRESS_UPDATE_INTERVAL === 0) {
              console.error(`[Progress] Objective-C: ${i}/${sourceFiles.objc.length} files processed`);
            }
            
            // Use clang to generate AST, use -x objective-c to force Objective-C mode
            const { stdout } = await execWithFile('clang', [...CLANG_AST_ARGS, file]);
            const ast = JSON.parse(stdout);
            const { symbols, memberData } = extractObjCSymbols(ast, file);
            files[file] = { symbols, memberData, language: 'objc' };
            objcProcessed++;
          } catch (error) {
            objcErrors++;
            errorDetails.push({ 
              file: getRelativePath(file), 
              language: 'objc',
              error: error.message 
            });
          }
        }
      } else if (!clangAvailable && sourceFiles.objc.length > 0) {
        // Clang not available, skip Objective-C files
        objcErrors = sourceFiles.objc.length;
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
      
      let message = `✅ Initialized: ${repoPath}

📱 Project: ${projectInfo.name} (${projectInfo.type})`;
      
      if (sourceFiles.swift.length > 0) {
        message += `\n📊 Swift: ${sourceFiles.swift.length} files (${swiftProcessed} OK, ${swiftErrors} errors)`;
      }
      
      if (sourceFiles.objc.length > 0) {
        if (clangAvailable) {
          message += `\n📊 Objective-C: ${sourceFiles.objc.length} files (${objcProcessed} OK, ${objcErrors} errors)`;
        } else {
          message += `\n⚠️  Objective-C: ${sourceFiles.objc.length} files skipped (Clang not available)`;
        }
      }
      
      message += `\n   Classes: ${classes} | Structs: ${structs} | Protocols: ${protocols} | Enums: ${enums} | Functions: ${functions}
   
📄 Saved to: ${outputPath}`;

      // Add error details if any errors occurred
      if (errorDetails.length > 0) {
        message += `\n\n⚠️  Errors encountered:\n`;
        const displayErrors = errorDetails.slice(0, MAX_DISPLAY_FILES);
        for (const err of displayErrors) {
          message += `   [${err.language}] ${err.file}\n      → ${err.error.split('\n')[0]}\n`;
        }
        if (errorDetails.length > MAX_DISPLAY_FILES) {
          message += `   ... +${errorDetails.length - MAX_DISPLAY_FILES} more errors\n`;
        }
      }
      
      return { content: [{ type: "text", text: message }] };
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
      for (const p of members.properties.slice(0, MAX_DISPLAY_PROPERTIES)) {
        r += `   • ${p.name}${p.type ? `: ${p.type}` : ''}${p.access && p.access !== 'internal' ? ` [${p.access}]` : ''}\n`;
      }
      if (members.properties.length > MAX_DISPLAY_PROPERTIES) r += `   ... +${members.properties.length - MAX_DISPLAY_PROPERTIES} more\n`;
    }
    
    if (members.initializers.length > 0) {
      r += `\n🔨 Initializers (${members.initializers.length}):\n`;
      for (const i of members.initializers) {
        r += `   • ${i.name}${i.access && i.access !== 'internal' ? ` [${i.access}]` : ''}\n`;
      }
    }
    
    if (members.methods.length > 0) {
      r += `\n⚡ Methods (${members.methods.length}):\n`;
      for (const m of members.methods.slice(0, MAX_DISPLAY_METHODS)) {
        r += `   • ${m.name}${m.returnType ? ` → ${m.returnType}` : ''}${m.access && m.access !== 'internal' ? ` [${m.access}]` : ''}\n`;
      }
      if (members.methods.length > MAX_DISPLAY_METHODS) r += `   ... +${members.methods.length - MAX_DISPLAY_METHODS} more\n`;
    }
    
    r += `\n🔗 Usage:\n`;
    if (inheritedBy.length > 0) {
      r += `   Inherited by: ${inheritedBy.map(x => x.name).join(', ')}\n`;
    }
    if (extensions.length > 0) {
      r += `   Extended in: ${extensions.map(x => x.file).join(', ')}\n`;
    }
    if (referencedIn.length > 0) {
      r += `   Referenced in: ${referencedIn.slice(0, MAX_DISPLAY_FILES).join(', ')}${referencedIn.length > MAX_DISPLAY_FILES ? ` +${referencedIn.length - MAX_DISPLAY_FILES} more` : ''}\n`;
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
    for (const item of results.slice(0, MAX_SEARCH_RESULTS)) {
      r += `• ${item.name} (${item.kind})`;
      if (item.inherited?.length > 0) r += ` : ${item.inherited.join(', ')}`;
      r += `\n  └─ ${item.file}\n`;
    }
    if (results.length > MAX_SEARCH_RESULTS) r += `\n... +${results.length - MAX_SEARCH_RESULTS} more`;
    
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
    for (const f of fileSizes.slice(0, MAX_DISPLAY_FILES)) {
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
        for (const item of sec.items.slice(0, MAX_DISPLAY_METHODS)) {
          r += `  • ${item.name}`;
          if (item.inheritedTypes?.length > 0) r += ` : ${item.inheritedTypes.join(', ')}`;
          if (item.typeName) r += ` → ${item.typeName}`;
          r += '\n';
        }
        if (sec.items.length > MAX_DISPLAY_METHODS) r += `  ... +${sec.items.length - MAX_DISPLAY_METHODS} more\n`;
        r += '\n';
      }
    }
    
    return { content: [{ type: "text", text: r }] };
  }
);

// ============== START SERVER ==============

const transport = new StdioServerTransport();
await server.connect(transport);
