---
name: architecture-diagram
description: "Generate or update the interactive architecture diagram (docs/architecture-diagram.html). Analyzes codebase structure, import relationships, and cron flows to produce a vis-network visualization."
allowed-tools: Bash(ls *), Read, Write, Edit, Glob, Grep, Agent
---

# Architecture Diagram Generator

Analyze the codebase and generate/update `docs/architecture-diagram.html` — an interactive vis-network visualization.

## Invocation

- `/architecture-diagram` — full regeneration from current codebase state

## What to Analyze

### Tab 1: 排程流程（Cron Flow）
The most important tab. Trace the actual call chains for:

1. **runAutoUpdate** (`src/cron-jobs/auto-update.js`)
   - Triggers: EventBridge daily, PubSub webhook, manual `/trigger-update`
   - Full step sequence: renewPubSub → fetchNewVideos → batchCreateStreams → saveThumbnail → fetchPendingStreams → parseSetlistForStream → processAndInsertSetlists → detectDebutSongs → sendDiscordNotification

2. **runPollingCheck** (`src/cron-jobs/auto-update.js`)
   - Trigger: EventBridge every 10 min (22:00~03:00 TST)
   - Flow: fetchPendingStreams → getLiveDetails → (if ended) parseSetlistForStream → batchCreateSetlist → sendDiscordNotification

3. **Group boxes**: When a flow step internally calls functions from other files, draw a dashed background box around the sub-nodes with the step name as title and source files in the top-right corner.

   Use `network.on('afterDrawing', ctx => { ... })` to draw group boxes by calculating bounding boxes of member node positions.

### Tab 2: 模組依賴（Module Dependencies）
Trace actual `import` statements across all `src/` files:
- Entry points → app.js → routes, utils, cron-jobs
- Cron → utils dependencies
- Frontend → API fetch calls (dashed edges)
- Lambda HTTP calls (dashed edges)

### Tab 3: 前端 SPA（Frontend SPA）
- SPA routing: setContent() → page components → API calls
- DuckDB-WASM local queries
- text-to-sql AI endpoint

## Visual Style

- Dark background (#0f0f23)
- Color coding by role: trigger (pink), process (blue), util (yellow), cron/notify (red), lambda (purple), entry (purple), route (green), frontend (teal)
- Hierarchical LR layout for cron flow, force-directed for module deps, hierarchical TB for SPA
- Group boxes: semi-transparent background + dashed border + title label + source file label

## How to Generate

1. **Explore**: Use Explore agents to trace imports and call chains across `src/`
2. **Build nodes and edges**: Map each function/module to a vis-network node, each call/import to an edge
3. **Define groups**: Identify which sub-nodes belong to which flow step
4. **Write HTML**: Single self-contained HTML file using vis-network CDN, no external dependencies

## Output

Write the result to `docs/architecture-diagram.html`. The file must be a single self-contained HTML file that can be opened directly in a browser.
