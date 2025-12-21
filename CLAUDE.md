# CLAUDE.md

This file provides guidance for AI assistants (like Claude) working with this codebase.

## Project Overview

**gpc-app** is a ChatGPT MCP (Model Context Protocol) todo application built with the OpenAI Apps SDK. It demonstrates how to:
- Build a web component that renders in ChatGPT's iframe
- Create an MCP server to expose tools to ChatGPT
- Use the `window.openai` bridge for ChatGPT communication

## Tech Stack

- **Runtime**: Node.js (v18+) with ES Modules
- **Framework**: Native Node.js HTTP server (no Express)
- **Protocol**: Model Context Protocol (MCP) via `@modelcontextprotocol/sdk`
- **Validation**: Zod for input schema validation
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework)

## Project Structure

```
gpc-app/
├── server.js                # MCP server implementation (main entry point)
├── public/
│   └── todo-widget.html     # Frontend UI component for ChatGPT iframe
├── package.json             # Project configuration and dependencies
├── README.md                # User documentation
└── CLAUDE.md                # This file (AI assistant guidance)
```

## Key Files

### server.js
The main server file that:
- Creates an MCP server with `McpServer` from the SDK
- Registers a UI widget resource (`todo-widget`) at `ui://widget/todo.html`
- Exposes two tools: `add_todo` and `complete_todo`
- Handles HTTP requests with CORS support
- Runs on port 8787 by default (configurable via `PORT` env var)

### public/todo-widget.html
The frontend widget that:
- Renders the todo list UI in ChatGPT's iframe
- Communicates with ChatGPT via `window.openai.callTool()`
- Supports standalone mode with local state fallback
- Uses modern CSS with Inter font family

## Development Commands

```bash
# Install dependencies
npm install

# Start the server (runs on http://localhost:8787/mcp)
npm start

# Test with MCP Inspector
npx @modelcontextprotocol/inspector@latest http://localhost:8787/mcp
```

## Architecture Patterns

### MCP Server Pattern
The server uses a stateless design where each request creates a new `McpServer` instance:
```javascript
const server = createTodoServer();
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,  // stateless mode
  enableJsonResponse: true,
});
```

### Tool Response Pattern
Tools return structured responses with both text content and structured data:
```javascript
const replyWithTodos = (message) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { tasks: todos },
});
```

### Input Validation Pattern
Zod schemas define tool input validation:
```javascript
const addTodoInputSchema = {
  title: z.string().min(1),
};
```

## Code Conventions

### JavaScript Style
- ES Modules (`import`/`export`) with `"type": "module"` in package.json
- Async/await for asynchronous operations
- Immutable array operations (spread operator for state updates)
- Arrow functions for handlers and callbacks

### MCP Tool Registration
Tools use this pattern with OpenAI-specific metadata:
```javascript
server.registerTool(
  "tool_name",
  {
    title: "Human readable title",
    description: "What the tool does",
    inputSchema: zodSchema,
    _meta: {
      "openai/outputTemplate": "ui://widget/todo.html",
      "openai/toolInvocation/invoking": "Action in progress",
      "openai/toolInvocation/invoked": "Action completed",
    },
  },
  async (args) => { /* handler */ }
);
```

### HTTP Server Pattern
- CORS headers are set for all `/mcp` endpoints
- OPTIONS requests handled for preflight
- Health check at `GET /`
- MCP requests at `/mcp` (POST, GET, DELETE)

## State Management

**Important**: The current implementation stores todos in memory (`let todos = []`). This state is:
- Shared across requests in the same server instance
- Lost when the server restarts
- Not persisted to any database

For production use, consider adding persistent storage.

## Deployment

The app is designed for deployment on Render (or similar platforms):
- Build command: `npm install`
- Start command: `npm start`
- The server respects the `PORT` environment variable

## Testing Approach

1. **Local testing**: Use `npm start` and test with MCP Inspector
2. **Integration testing**: Deploy and test via ChatGPT connector
3. **Standalone testing**: Open `public/todo-widget.html` directly in browser

## Common Tasks for AI Assistants

### Adding a New Tool
1. Define the input schema with Zod in `server.js`
2. Register the tool using `server.registerTool()`
3. Include appropriate OpenAI metadata for UI integration
4. Update the widget if UI changes are needed

### Modifying the UI
1. Edit `public/todo-widget.html`
2. The widget is loaded at server startup via `readFileSync`
3. Changes require server restart

### Adding New Dependencies
1. Add to `package.json` dependencies
2. Run `npm install`
3. Import in `server.js` using ES Module syntax

## Important Notes

- The project uses ES Modules exclusively - no CommonJS `require()`
- CORS is configured to allow all origins (`*`) for development
- The MCP endpoint path is `/mcp` (not root)
- The widget uses the `text/html+skybridge` MIME type for ChatGPT integration
