# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-01-23

### Added
- Added limits (48 message requests per day, 8 image generations per day)
- Added ability to add your own HackAI API key with no limits
- Added message branching with editing/regenerating messages

### Fixed
- Kimi K2 non-reasoning now functions as intended and does not route to Kimi K2 reasoning
- Errors will now be visible to the user for enhanced debugging
- Removed deprecated models (Gemini 3 Pro Preview, Gemini 3 Pro Image Preview)
- Enhanced visual polish


## [0.5.0] - 2026-01-07

### Added
- Added models (Gemini 3 Pro Image Preview, Gemini 2.5 Flash Image, GLM 4.7)
- Added full image generation functionality
- Reasoning and tool use is incorporated into model context

### Fixed
- Refactored the part system, resulting in more reliable streaming & tool use and fewer gaps between tools in the UI
- Annotations from documents are now properly stored and passed into model context
- Images are stored in model context throughout the chat without need to reupload them again

## [0.4.1] - 2025-12-19

### Fixed
- Refactored default model behaviour

## [0.4.0] - 2025-12-19

### Added
- Added models (Gemin 3 Flash Preview, Qwen3-Next Instruct, Qwen3-VL-235b Instruct)
- Implemented search tool/endpoint using search.hackclub.com
- Added interleaved thinking (think -> tool -> think so on and so forth, allowing for more in-depth research)
- Implemented chat widgets to show reasoning/tools in chat reliably
- Added keyboard shortcuts

## [0.3.1] - 2025-12-06

### Fixed
- Updated file upload limit from 20mb to 4.5mb (Vercel's limit is 4.5mb)
- Converted images to webp and resize larger photos to ~3000px to fit the 4.5mb required
- Allowed users to drag/paste images into the chat

## [0.3.0] - 2025-12-06

### Added
- Added image upload support (png, jpg, webp, gif, pdf)

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