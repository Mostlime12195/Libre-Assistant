# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2025-12-04

### Fixed
- Added KaTex font to main.css, fixing math equation rendering

## [0.2.0] - 2025-12-04

### Added
- Vector embeddings to detirmine memory relevance to query (only related memories are appended to model context)
- 'isGlobal' tag for memories, designating whether the memory should always be appended or only appended when relevant to the query
- 'new chat' shorthand button in top bar
- Revamped message form UI
- Polished button UI

### Fixed
- Several UI bugs
- Chats storage/creation
- Model selection

## [0.1.0] - 2025-11-25

### Added
- Initial release of Libre Assistant
- Core Nuxt.js application structure
- SEO and sitemap capabilities
- Markdown rendering support with syntax highlighting
- Math equation rendering (KaTeX)
- Task list support in markdown
- Animation capabilities with anime.js
- Multiple icon libraries support
- OpenAI integration
- Vercel analytics and speed insights
- Local data storage for chat history
- Customizable user preferences and instructions
- Web grounding support
- Incognito mode for private conversations
- Global memory for remembering user details
- Parameter configuration panel