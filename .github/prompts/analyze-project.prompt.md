---
description: Analyze a Swift/iOS project and get an overview
---

# Analyze Swift Project

Analyze the Swift/iOS project and provide a comprehensive overview.

## Data Source

All analysis reads from **app.json** — the pre-generated AST file created by SourceKitten.

## Prerequisites

The project path must contain:
- `.xcworkspace` (preferred) OR `.xcodeproj`

If neither is found, **abort** — this tool only works with iOS/macOS Xcode projects.

## Steps

1. **Initialize** — Use `init_swift_repo` with the project path
   - This runs SourceKitten on all `.swift` files
   - Generates `app.json` in the project root
   - If error "Not an iOS/Swift project" → stop and report
2. **Get Stats** — Use `get_codebase_stats` (reads from app.json)
3. **Find Entry Points** — Use `search_symbols` for AppDelegate, ContentView, @main

## Output Format

| Section | Content |
|---------|--------|
| Statistics | Files, classes, structs, protocols, enums |
| Entry Points | AppDelegate, @main, ContentView |
| Largest Files | Top 5 by symbol count |
| Architecture | Patterns observed (MVVM, MVC, etc.) |
