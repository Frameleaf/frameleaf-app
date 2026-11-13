# Connect a local AI assistant

Use a desktop assistant to search photos and videos and browse albums in Frameleaf Library. The assistant connects from your computer, so Library can stay on your home network. A Server licence works offline with your Library sign-in. Your assistant provider may still require an internet connection.

## Before you connect

- Open Library from your computer using HTTPS. Use the same address in the assistant. If you manage the certificate, add its issuing CA to your operating system’s trusted certificates. Restart your browser and assistant after changing certificate trust.
- If your own reverse proxy handles HTTPS, set Library’s `FRAMELEAF_TRUSTED_PROXIES` to the proxy address and have the proxy set `X-Forwarded-Proto: https`.
- In Library’s administration settings under **Sign-in methods → Registered apps**, turn on **AI agents (MCP)**. Keep **Let new apps register themselves** on while you add the connector for the first time.

## Claude Desktop

1. Open **Settings → Desktop app → Extensions → Manage** in Claude Desktop. In the older settings layout, open **Settings → Extensions**.
2. Open **Advanced settings**, choose **Install Extension**, and select the Frameleaf Assistant `.mcpb` file.
3. Enter your Library HTTPS address in the extension settings.
4. In a chat, enable Frameleaf Assistant and ask it to list your albums. Sign in to Library in the browser window that opens, review the requested access, and choose **Allow**. Return to Claude and repeat your request if it timed out during sign-in.

## Other local MCP clients

If your client supports Streamable HTTP with OAuth, dynamic client registration, and a loopback callback, add `https://library.example/api/mcp/assistant` as an MCP server. Replace `https://library.example` with your Library HTTPS address. Sign in in the browser when prompted and choose **Allow**.

For a client that launches local stdio servers, extract the Frameleaf Assistant bundle and configure your client to run the adapter. Use Node.js 22.15 or later. The bundle includes macOS and Windows credential-store support. On Linux, install the adapter from source with `npm ci --omit=dev` and run it in a desktop session with an unlocked Secret Service keyring.

```json
{
  "mcpServers": {
    "frameleaf": {
      "command": "node",
      "args": ["/path/to/frameleaf-assistant/server.mjs", "https://library.example"]
    }
  }
}
```

Use the absolute path to the extracted `server.mjs` and the address you use to open Library. Exact settings vary by client.

## Review or remove access

The connector can search the visible Library and read albums. It stores sign-in credentials in your operating system’s credential store. Results go to the assistant, whose data and conversation settings apply.

In Library, open **Settings → Your sign-in & privacy → Connected apps**, find **Frameleaf Assistant**, and remove its access. To connect a different Library account at the same address, remove the existing grant, sign in to the desired account in your browser, and ask the assistant to list albums again.

## Connect from ChatGPT or Claude

1. Find **Frameleaf** in ChatGPT’s app directory or Claude’s connector directory and choose **Connect**.
2. Sign in with Frameleaf and choose your Library.
3. Review the access request and approve it. Return to the assistant and ask it to list your albums.

With a Server licence, the assistant needs to reach Library over direct Frameleaf HTTPS remote access. An eligible Frameleaf Cloud relay connection works without opening incoming ports. If a Library is unavailable during setup, open it first, confirm it is online and reachable through Frameleaf remote access, and check that its administrator allows AI agents in **Sign-in methods → Registered apps**. Then try connecting again.

Remove the connection from the assistant’s settings. You can also remove its access from **Settings → Your sign-in & privacy → Connected apps** in Library or disconnect it from your Frameleaf Cloud account.
