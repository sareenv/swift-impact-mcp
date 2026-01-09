---
description: Find what uses or depends on a symbol
---

# Find Usages

Find all classes, structs, and files that use or depend on a specific symbol.

## Data Source

All analysis reads from **app.json** — the pre-generated AST file containing:
- Type definitions (classes, structs, protocols, enums)
- Inheritance/conformance relationships  
- File-to-symbol mappings

If not loaded, use `load_ast` first.

## Steps

1. **Get symbol info** — Use `explain_symbol(symbolName: "X")`
   - Check "Referenced in" for files using it
   - Check "Inherits/Conforms" for relationships
2. **Find related types** — Use `search_symbols` if needed
3. **Check file context** — Use `get_file_overview` for full file picture

## Output Format

### Direct Usages

| File | Relationship |
|------|-------------|
| Controllers/UserVC.swift | Inherits from it |
| Services/AuthService.swift | Conforms to it |
| Views/ProfileView.swift | Instantiates it |

### Inheritance/Conformance Tree

```
BaseProtocol
├── ServiceA (conforms)
├── ServiceB (conforms)
└── ExtendedProtocol (inherits)
    └── ServiceC (conforms)
```

### Impact Assessment

| Metric | Value |
|--------|-------|
| Files affected | N |
| Direct dependents | N |
| Risk level | Low / Medium / High |
| Safe to modify? | Yes / No |

All queries read from the pre-generated `app.json` AST file.
The AST is created by `init_swift_repo` using SourceKitten.
