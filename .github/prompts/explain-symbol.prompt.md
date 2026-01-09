---
description: Explain how a Swift class, struct, or protocol works
---

# Explain Symbol

Explain how the specified symbol works and how it's used in the codebase.

## Data Source

All analysis reads from **app.json** — the pre-generated AST file. If not loaded, use `load_ast` first.

## Steps

1. **Explain** — Use `explain_symbol(symbolName: "X")` 
   - Reads symbol data from app.json
2. **If not found** — Use `search_symbols(query: "X")` to find similar names
3. **For more context** — Use `get_file_overview` on the symbol's file

## Output Format

### Overview
| Field | Value |
|-------|-------|
| Type | class / struct / protocol / enum |
| Location | path/to/File.swift |
| Inherits | ParentClass, Protocol1, Protocol2 |

### Structure
| Property | Type | Access |
|----------|------|--------|
| name | String | internal |

| Method | Returns | Access |
|--------|---------|--------|
| fetch() | Data | public |

### Usage
- What inherits/conforms to it
- Which files reference it
- How it fits in the architecture
