# Swift Impact Analysis MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<img width="2796" height="2330" alt="image" src="https://github.com/user-attachments/assets/39b74732-3080-4c56-8093-b4fdd4eb77ab" />

A lightweight MCP server for analyzing Swift and Objective-C codebases using SourceKitten and Clang AST parsing.

## Quick Start

```bash
# Install dependencies
npm install
brew install sourcekitten  # For Swift analysis

# Clang is included with Xcode Command Line Tools
# If not already installed:
xcode-select --install

# Run
npm start
```

### Configure for VS Code

Create a `.vscode` directory in your project root and add an `mcp.json` file:

```bash
mkdir .vscode
```

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "swift-impact-analyzer": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server.js"],
      "cwd": "${workspaceFolder}"
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
# Start analysis (works with Swift-only, Objective-C-only, or mixed projects)
Analyze the Swift project at /Users/me/MyApp

# Understand code (works for both Swift and Objective-C symbols)
How does ContentView work?
Explain the NetworkService class
Explain the MyViewController class  # Even if it's Objective-C

# Find code
Find all controllers
List all protocols  # Includes both Swift and Objective-C protocols

# Overview
Show me the project statistics  # Shows counts for both languages
What's in the Models folder?
```

## Language Support

### Supported Languages

| Language | Parser | Features Extracted |
|----------|--------|-------------------|
| **Swift** | SourceKitten | Classes, Structs, Protocols, Enums, Functions, Extensions, Properties, Methods |
| **Objective-C** | Clang | Classes, Protocols, Categories, Properties, Methods |

### Cross-Language Analysis

The tool automatically detects and analyzes both Swift and Objective-C files in mixed codebases:
- **Inheritance tracking**: Swift classes inheriting from Objective-C classes
- **Protocol conformance**: Both Swift and Objective-C protocol implementations
- **Categories/Extensions**: Objective-C categories and Swift extensions on the same types
- **Unified symbol lookup**: Search and explain symbols from both languages

### Known Issues

- **Clang crashes**: Some Objective-C protocol declarations may cause Clang v18.1.3 to crash during JSON AST generation. These files are gracefully skipped and counted as errors in the output.
- **Foundation headers**: On non-macOS systems, Objective-C files that import Foundation headers may fail to parse if the headers are not available.

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

1. `init_swift_repo` runs SourceKitten on each `.swift` file and Clang on each `.m`/`.h` file
2. Extracts classes, structs, protocols, enums, functions from both Swift and Objective-C code
3. Builds inheritance/conformance graph across both languages
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
- **Cross-language** — Analyzes both Swift and Objective-C in the same codebase
- **No Xcode needed** — Works from terminal/VS Code via MCP

## Limitations

| Limitation | Details |
|------------|---------|
| **Static analysis** | No runtime behavior, just code structure |
| **No semantic search** | Finds by name, not by "what code does" |
| **No Interface Builder** | Doesn't parse `.xib`, `.storyboard`, or asset catalogs |
| **Clang JSON bugs** | Some Objective-C constructs may cause Clang to crash (known bug in Clang 18.1.3 with protocol method mangling) - these files are skipped with errors counted |

> **Note:** Mixed Swift/Objective-C projects are fully supported. Both Swift and Objective-C code will be analyzed and cross-language dependencies are tracked.

## Credits

This project relies on [**SourceKitten**](https://github.com/jpsim/SourceKitten) by [JP Simard](https://github.com/jpsim) — a Swift tool that interfaces with Apple's SourceKit framework to provide accurate AST parsing. SourceKitten powers tools like [SwiftLint](https://github.com/realm/SwiftLint) and [Jazzy](https://github.com/realm/jazzy).

```bash
brew install sourcekitten
```

## Disclaimer

⚠️ **USE AT YOUR OWN RISK**

This software is provided **"as is"**, without warranty of any kind, express or implied.

- ✅ Free to use for **commercial and personal purposes**
- ❌ **No guarantees** of functionality, accuracy, or fitness for any purpose
- ❌ **No support or maintenance** promised — you are responsible for your own maintenance overhead
- ❌ **No liability** for any damages or issues arising from use

By using this tool, you accept full responsibility for any outcomes.

## License

MIT