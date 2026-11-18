<img src="logo.svg" alt="perch" width="128">

# perch

perch lets your AI agent use the browser you already have open on your Mac: Chrome, Arc and the other Chrome-family browsers, and Safari, with no extension and no debug flags. Built for [avis](https://github.com/sryo/avis). It also lets [figma-cdp](https://github.com/sryo/figma-cdp) work in your open Figma tabs without Chrome asking you to allow remote debugging. It drives [rooms](https://github.com/sryo/rooms) too, browsers of the agent's own that stay signed in and leave your windows alone. With [loft](https://github.com/sryo/loft) up, it can open a browser window of its own on a hidden screen, where nothing covers or slows it and it stays out of your way.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sryo/perch/main/install.sh | bash
```

It sets perch up in each agent app it finds on your Mac (Claude Code, Codex, GitHub Copilot, Cursor, VS Code) and leaves the other servers you have there alone. Restart your agent; `perch` should appear in its MCP listing.

It then checks each permission perch needs, in every browser you have open, and says which are missing and where to turn them on, opening that page of System Settings for you. Run the installer again any time to check again; it only changes what isn't set up yet.

The permissions, allowed once: macOS asks whether the app running your agent may control your browser (Automation); in the browser you turn on Allow JavaScript from Apple Events; and for clicks, key presses and screenshots, System Settings lists the app running your agent under Accessibility and Screen Recording.

## Use

Ask your agent for things in a tab you have open: "fill this application from my resume", "what does this page say about pricing?", "click through the signup and tell me what breaks".
