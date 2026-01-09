---
name: Swift Analysis
description: Instructions for analyzing Swift/iOS codebases using the MCP server
applyTo: "**/*.swift"
---

# Swift Code Analysis Instructions

When working with Swift files, use the Swift Impact Analysis MCP tools:

## Tool Selection

| User Intent | Tool |
|-------------|------|
| "How does X work?" | `explain_symbol(symbolName: "X")` |
| "What is X?" | `explain_symbol(symbolName: "X")` |
| "Find all X" | `search_symbols(query: "X")` |
| "List all controllers/models/etc" | `search_symbols(query: "Controller")` |
| "What's in this file?" | `get_file_overview(filePath: "filename")` |
| "Project overview" | `get_codebase_stats()` |

## Before Using Tools

1. **Verify iOS project** - The path must contain `.xcodeproj` or `.xcworkspace`
2. If not an iOS project, abort and inform the user
3. Check if AST is loaded - if not, use `init_swift_repo` or `load_ast`
4. For symbol names, use exact PascalCase names (e.g., "UserManager" not "user manager")

## Project Validation

The `init_swift_repo` tool will:
- Check for `.xcworkspace` first (preferred, includes CocoaPods/SPM)
- Fall back to `.xcodeproj` if no workspace exists
- **Abort with error** if neither is found (not an iOS project)

## Response Format

After using `explain_symbol`, present results as:
- Type and location
- Inheritance/conformance  
- Properties table
- Methods table
- Usage locations

After using `search_symbols`, group results by type (classes, structs, protocols, etc.)
