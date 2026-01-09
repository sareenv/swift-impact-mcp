---
name: MCP Server
description: Instructions for working with the MCP server code
applyTo: "**/mcp-server.js"
---

# MCP Server Development Instructions

This is a Model Context Protocol (MCP) server for Swift code analysis.

## Architecture

- Uses `@modelcontextprotocol/sdk` for MCP protocol
- Uses `sourcekitten` CLI for Swift AST parsing
- Stores parsed AST in `app.json` files

## Tools Provided

1. `init_swift_repo` - Generate AST from Swift/iOS project (validates xcodeproj/xcworkspace)
2. `load_ast` - Load existing app.json
3. `explain_symbol` - Main analysis tool
4. `search_symbols` - Find symbols by name
5. `get_codebase_stats` - Project statistics
6. `get_file_overview` - File contents

## Project Validation (init_swift_repo)

The server validates iOS projects before analysis:

```javascript
// detectProjectType() checks for:
// 1. .xcworkspace (priority - includes Pods/SPM)
// 2. .xcodeproj (fallback)
// Returns null if neither found → abort
```

Abort conditions:
- No `.xcodeproj` or `.xcworkspace` found → "Not an iOS/Swift project"
- Project found but no `.swift` files → "No Swift files in iOS project"

## Key Patterns

- All tools check `if (!astData)` first
- Use `getRelativePath()` for display paths
- Use `findSymbol()` to locate symbols in AST
- Responses use emoji prefixes for sections
