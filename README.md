# Swift Impact Analysis MCP Server
<img width="2796" height="2330" alt="image" src="https://github.com/user-attachments/assets/39b74732-3080-4c56-8093-b4fdd4eb77ab" />

A lightweight MCP server for analyzing Swift/iOS codebases using SourceKitten AST parsing.

## Quick Start

```bash
# Install
npm install
brew install sourcekitten

# Run
npm start
```

### Configure MCP Client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "swift-impact": {
      "command": "node",
      "args": ["/path/to/mcp-impact-analysis/mcp-server.js"]
    }
  }
}
```

## Tools

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `init_swift_repo` | Analyze Swift project | "Analyze /path/to/MyApp" |
| `load_ast` | Load existing app.json | "Load the app.json" |
| `explain_symbol` | Explain a symbol | "How does UserManager work?" |
| `search_symbols` | Find symbols | "Find all ViewModels" |
| `get_codebase_stats` | Project overview | "Show project statistics" |
| `get_file_overview` | File contents | "What's in AppDelegate.swift?" |

## Example Usage

```
# Start analysis
Analyze the Swift project at /Users/me/MyApp

# Understand code
How does ContentView work?
Explain the NetworkService class

# Find code
Find all controllers
List all protocols

# Overview
Show me the project statistics
What's in the Models folder?
```

## Files

```
mcp-impact-analysis/
├── mcp-server.js                    # MCP server
├── package.json
├── README.md
├── *.prompt.md                      # Reusable prompts
└── .github/
    ├── copilot-instructions.md      # Main AI instructions
    └── instructions/
        ├── swift-analysis.instructions.md
        └── mcp-server.instructions.md
```

## How It Works

1. `init_swift_repo` runs SourceKitten on each `.swift` file
2. Extracts classes, structs, protocols, enums, functions
3. Builds inheritance/conformance graph
4. Saves to `app.json`
5. Other tools query the AST

## Why Use This?

| Scenario | Without Tool | With Tool |
|----------|--------------|-----------|
| "How does `UserManager` work?" | Open file, read code, trace imports | `explain_symbol` → instant summary |
| "What uses `BaseProtocol`?" | Cmd+Shift+F, grep, manual tracing | See all conformances in one call |
| "Overview of new codebase" | Browse folders, read files | `get_codebase_stats` → full breakdown |
| "Find all ViewModels" | Grep, hope naming is consistent | `search_symbols` → grouped list |
| "Safe to refactor X?" | Manually trace dependencies | See "Referenced in" count |

### Key Benefits

- **Speed** — AST is pre-generated, queries are instant
- **AI-friendly** — Structured results for LLM consumption
- **Cross-file awareness** — Understands inheritance, conformance, references
- **No Xcode needed** — Works from terminal/VS Code via MCP

## Limitations

| Limitation | Details |
|------------|---------|
| **Swift only** | Does not parse Objective-C (`.m`, `.h` files) |
| **Static analysis** | No runtime behavior, just code structure |
| **No semantic search** | Finds by name, not by "what code does" |
| **No Interface Builder** | Doesn't parse `.xib`, `.storyboard`, or asset catalogs |

> **Note:** Mixed Swift/Objective-C projects will only have their Swift code analyzed. Objective-C classes, categories, and protocols will not appear in the AST.

## License

MIT
