# Libre Assistant

Libre Assistant is a **free, unlimited** AI Chatbot that uses various models through [Hack Club's free API](https://ai.hackclub.com).
Libre Assistant does **not** sell or store user information, and all chat & user data is stored on your device.

## Features

- All data is stored locally on your device. No data is stored on the internet.
- Full Markdown & LaTeX Support.
- Support for multiple chats.
- Detailed code-blocks, including syntax highlighting, downloading, and a copy button.
- Customizable with name, occupation, and custom instructions.
- Reasoning is visible and properly styled.
- Basic web grounding.
- Reasoning effort customizability.
- Incognito mode to prevent chat history from being saved.
- Global memory to remember user details/preferences/opinions across chats.
- Parameter configuration panel with temperature, top_p, seed options, and a web grounding toggle.

## Todo

- Canvas/Code Panel
- Tree-of-Thought (Multiple instances of the same or different models working together to solve a problem at the same time)

Please suggest more ideas in the Issues tab.

## VSCode Setup

[VSCode](https://code.visualstudio.com/).

### Clone Project and Move into Its Folder

```sh
git clone https://github.com/Mostlime12195/Libre-Assistant.git
cd libre-assistant
```

### Install Dependencies

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Compile and Minify for Production

```sh
npm run build
```

## Versioning

This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To update the version, use npm version commands:

```bash
# Bump the patch version (x.y.z -> x.y.z+1)
npm version patch

# Bump the minor version (x.y.z -> x.y+1.0)
npm version minor

# Bump the major version (x.y.z -> x+1.0.0)
npm version major

# Or set an explicit version
npm version 1.2.3
```

All notable changes to this project are documented in the [CHANGELOG.md](./CHANGELOG.md) file.