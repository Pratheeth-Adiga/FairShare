FairShare web {{VERSION}}

Requires Node.js 22 or newer. No npm install or build is needed.
Extract the entire archive and open a terminal in its folder:

  node server.mjs

Open http://localhost:8080 on this computer. Press Ctrl+C to stop.

Optional port:
  PowerShell: $env:PORT='9000'; node server.mjs
  Linux/macOS: PORT=9000 node server.mjs

The default bind address is 127.0.0.1 (local access only).
For remote access, set HOST=0.0.0.0 and use an HTTPS reverse proxy with a
trusted certificate. Plain HTTP on a LAN IP is not a secure context and
cannot provide all required browser features. Localhost is an exception.
Never expose the HTTP server directly on the public Internet.

Serve the app at the domain root, not a subdirectory. Another static server
can serve public/ instead: fall back to index.html for app routes, return
404 for missing assets, and revalidate index.html and sw.js on updates.

This server only serves app files. Each browser keeps its own identity and
groups locally. There is no data backend or WebRTC relay. Changing host,
port, or browser uses separate browser storage: back up before moving.
Identity exports contain a private key and must be kept private.

The archive contains no Android/iOS projects or personal data.
