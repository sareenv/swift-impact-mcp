---
description: Find and list symbols matching a pattern
---

# Find Symbols

Search for classes, structs, protocols, functions, or enums by name pattern.

## Data Source

All searches query **app.json** — the pre-generated AST file. If not loaded, use `load_ast` first.

## Steps

1. **Search** — Use `search_symbols(query: "X")`
   - Case-insensitive partial match
   - Searches all symbol names in app.json
2. **Filter by type** — Add `type` parameter:
   - `class`, `struct`, `protocol`, `function`, `enum`, `extension`

## Examples

| Query | Tool Call |
|-------|----------|
| "Find all ViewModels" | `search_symbols(query: "ViewModel")` |
| "List all protocols" | `search_symbols(query: "", type: "protocol")` |
| "Find Manager classes" | `search_symbols(query: "Manager", type: "class")` |

## Output Format

Group results by type:

### Classes (N found)
| Name | Inherits | Location |
|------|----------|----------|
| UserManager | NSObject | Services/UserManager.swift |

### Structs (N found)
...

Highlight patterns observed (e.g., "All ViewModels inherit from BaseViewModel")
