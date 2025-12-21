# gpc-app

ChatGPT MCP todo app with OpenAI Apps SDK

## Overview

This is a simple todo list application built using the [OpenAI Apps SDK](https://platform.openai.com/docs/apps-sdk) and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). The app demonstrates how to:

- Build a web component that renders in ChatGPT's iframe
- Create an MCP server to expose tools to ChatGPT
- Use the `window.openai` bridge to communicate between your app and ChatGPT

## Architecture (Agentic CRE Platform)

The production architecture for the agentic CRE platform (ingestion, underwriting, scenario modeling, comps, capital stack, approvals) and its mapping to the OpenAI Apps SDK + MCP tooling is documented here:

- [Agentic CRE Architecture](docs/cre-architecture.md)

## Project Structure

```
gpc-app/
├── public/
│   └── todo-widget.html    # Frontend UI component
├── server.js                # MCP server implementation
├── package.json             # Project dependencies
└── README.md                # This file
```

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone https://github.com/blakegallagher1/gpc-app.git
cd gpc-app
```

2. Install dependencies:
```bash
npm install
```

## Local Development

### Run the Server

Start the MCP server locally:

```bash
npm start
```

The server will start on `http://localhost:8787/mcp` by default.

### Test with MCP Inspector

You can test your server locally using the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector@latest http://localhost:8787/mcp
```

## Deployment with Render

### Option 1: Deploy via Render Dashboard

1. Sign up for a free account at [Render](https://render.com)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: `gpc-app` (or any name you prefer)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Select the Free tier
5. Click "Create Web Service"

Render will automatically deploy your app and provide a public URL like:
```
https://gpc-app.onrender.com
```

### Option 2: Deploy via Render Blueprint

Create a `render.yaml` file in your repository:

```yaml
services:
  - type: web
    name: gpc-app
    env: node
    buildCommand: npm install
    startCommand: npm start
    plan: free
```

Then deploy via Render's Blueprint:
1. Go to Render Dashboard
2. Click "New +" → "Blueprint"
3. Connect your repository
4. Render will detect the `render.yaml` and deploy automatically

### Environment Variables

If you need to customize the port, add an environment variable in Render:
- Key: `PORT`
- Value: `8787` (or your preferred port)

Note: Render automatically sets `PORT`, so you typically don't need to configure this.

## Add Your App to ChatGPT

Once deployed, integrate your app with ChatGPT:

1. Enable [developer mode](https://platform.openai.com/docs/guides/developer-mode) in ChatGPT:
   - Go to Settings → Apps & Connectors → Advanced settings
   - Enable Developer Mode

2. Create a connector:
   - Go to Settings → Connectors
   - Click "Create"
   - Enter your MCP endpoint: `https://your-app.onrender.com/mcp`
   - Add a name and description
   - Click "Create"

3. Test the app:
   - Open a new chat
   - Click the "+" button and select your connector
   - Try prompts like:
     - "Add a new task to read my book"
     - "Complete the first task"
     - "Show me my todo list"

## Features

### Tools Exposed to ChatGPT

- **add_todo**: Creates a new todo item with a title
- **complete_todo**: Marks a todo as completed by ID

### UI Features

- Clean, modern interface with Inter font
- Add tasks via form input
- Check off tasks to mark as complete
- Syncs with ChatGPT via `window.openai.callTool()`
- Graceful degradation when running standalone

## Development Tips

### Refresh Connector in ChatGPT

After making changes to your MCP server:
1. Go to Settings → Connectors in ChatGPT
2. Find your connector
3. Click the "Refresh" button

This ensures ChatGPT picks up the latest tool definitions.

### Monitoring Logs on Render

- Go to your service dashboard on Render
- Click the "Logs" tab
- Watch real-time logs as requests come in

### Health Check

Your server responds to `GET /` with a simple health check:
```bash
curl https://your-app.onrender.com/
# Returns: Todo MCP server
```

## Troubleshooting

### Server not starting
- Check that `"type": "module"` is in your `package.json`
- Verify all dependencies are installed
- Check Render logs for startup errors

### ChatGPT can't connect
- Ensure your Render service is running (not sleeping)
- Verify the URL includes `/mcp` path
- Check CORS headers are properly set
- On Render's free tier, services may spin down after inactivity and take 30-60 seconds to wake up

### Tools not working
- Refresh the connector in ChatGPT Settings
- Check server logs for errors
- Test with MCP Inspector to isolate issues

## Resources

- [OpenAI Apps SDK Documentation](https://platform.openai.com/docs/apps-sdk)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [OpenAI Apps Examples](https://github.com/openai/openai-apps-sdk-examples)
- [Render Documentation](https://render.com/docs)

## License

MIT
