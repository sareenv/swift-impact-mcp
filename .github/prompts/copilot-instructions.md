# Swift Impact Analysis MCP Server

You have access to a Swift code analysis MCP server that parses Swift/iOS codebases using SourceKitten AST.

## Quick Reference

| Tool | When to Use | Example |
|------|-------------|---------|
| `init_swift_repo` | Analyze a new project | `init_swift_repo(repoPath: "/path/to/MyApp")` |
| `load_ast` | Load existing analysis | `load_ast(astPath: "/path/to/app.json")` |
| `explain_symbol` | "How does X work?" | `explain_symbol(symbolName: "UserManager")` |
| `search_symbols` | "Find all X" | `search_symbols(query: "ViewModel")` |
| `get_codebase_stats` | "Project overview" | `get_codebase_stats()` |
| `get_file_overview` | "What's in file?" | `get_file_overview(filePath: "AppDelegate")` |

## Workflow

1. **First**: Initialize or load AST (required before other tools)
2. **Then**: Use `explain_symbol` for "how does X work?" questions
3. **Or**: Use `search_symbols` for "find all X" questions

## User Intent → Tool Mapping

- "Analyze /path/to/project" → `init_swift_repo`
- "How does X work?" / "What is X?" → `explain_symbol`
- "Find all controllers/models/services" → `search_symbols`
- "List all protocols/enums/structs" → `search_symbols` with `type` filter
- "What's in filename.swift?" → `get_file_overview`
- "Project overview" / "How big?" → `get_codebase_stats`

## Response Format

- Use tables for properties and methods
- Always include file locations
- Group search results by type
- If symbol not found, suggest `search_symbols` to find similar names
