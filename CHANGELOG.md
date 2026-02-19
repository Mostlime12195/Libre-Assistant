# Changelog

All notable changes to Libre Assistant are documented here.

## Change Type Definitions

- **Added** — New features, capabilities, or content that didn't exist before
- **Changed** — Modifications to existing features, behavior, or defaults
- **Fixed** — Bug fixes and corrections to existing functionality
- **Removed** — Features, content, or capabilities that have been deleted
- **Deprecated** — Features that still work but are planned for removal in future versions
- **Security** — Security-related improvements or vulnerability fixes

---

## [0.9.0] - 2026-02-19

### Added
- Perplexity's Sonar Deep Research model
- Ability to search for chats
- Ability to pin chats to the top of the search bar
- Ability to rename chats

### Changed
- **Redesigned Sidebar** — Redesigned sidebar UI for sleeker, simpler design with markers denoting when chats were made (today, this week, this month, etc.) and combined chat action buttons into one options popover.
- Redesigned how model information is stored internally

### Fixed
- Streaming content now has fewer repeating/missing text blocks


## [0.8.1] - 2026-02-13

### Added
- Readded caret that was removed in v0.8.0

### Changed
- Caret now appears inline as the message is streaming, as opposed to only until the first token is generated
- Caret is now stylized when within code blocks

## [0.8.0] - 2026-02-13

### Added
- GLM-5 model
- MiniMax M2.5 model

### Changed
- **Faster and smoother message rendering** — Messages now stream more smoothly with less lag, especially for long responses with code blocks
- **Better math equation display** — LaTeX equations now appear immediately during streaming instead of jumping in after completion
- **Improved code block rendering** — Code blocks with multiple blank lines no longer break into separate fragments
- **More consistent spacing** — Fixed visual glitches where spacing between message blocks would flicker during streaming
- **Better performance for long conversations** — Reduced unnecessary re-rendering and improved scroll handling efficiency
- **Smarter syntax highlighting** — Code blocks are now highlighted as they scroll into view, reducing initial load time

---

## [0.7.0] - 2026-02-05

### Added
- **Connection timeout protection** — Streams that stall for more than 60 seconds will automatically timeout with a clear error message

### Changed
- **Unlimited tool iterations** — The assistant can now use tools as many times as needed without artificial limits (previously capped at 4)
- **Smoother streaming** — Completely rewrote how messages stream to your screen for buttery-smooth 60fps rendering with less delay
- **Better error messages** — When API quota is exhausted, you'll now see clear details about your remaining balance

### Removed
- Removed caret (temporarily)

### Fixed
- Fixed crashes when attaching PDF files
- Fixed issues where tools would execute with empty arguments instead of showing errors to the model
- Fixed API health check to properly display when services are down

---

## [0.6.2] - 2026-01-27

### Added
- Kimi K2.5 model
- GLM 4.7 Flash model

### Changed
- **Default model** — Switched from Kimi K2 to Kimi K2.5
- **Title generation** — Now uses GLM 4.7 Flash instead of Gemini 2.5 Flash for faster performance
- **Improved caching** — Moved timestamps to system prompt for better response caching
- **Memory reliability** — More consistent memory management
- **Error handling** — Better messages when API services are unavailable
- **System prompt** — Clearer instructions to the AI for when to save memories

---

## [0.6.1] - 2026-01-25

### Added
- Grok 4.1 Fast model
- MiniMax M2.1 model
- GPT-5.2 model
- Gemini 3 Pro Preview model

---

## [0.6.0] - 2026-01-23

### Added
- **Message branching** — Edit your messages or regenerate AI responses to explore different conversation paths. Navigate between branches with arrow buttons
- **Daily usage limits** — Free tier now has 48 message requests and 8 image generations per day
- **Custom API keys** — Add your own HackAI API key to remove all limits

### Changed
- **Kimi K2 non-reasoning** — Now works correctly (previously routed to reasoning mode)
- **Error visibility** — Errors are now visible in the chat for easier troubleshooting
- **Visual polish** — Overall UI refinements

### Removed
- Gemini 3 Pro Preview model (deprecated)
- Gemini 3 Pro Image Preview model (deprecated)

---

## [0.5.0] - 2026-01-07

### Added
- **Image generation** — The assistant can now create images for you
- Gemini 3 Pro Image Preview model
- Gemini 2.5 Flash Image model
- GLM 4.7 model
- **Smarter context** — Reasoning and tool use are now included in conversation history for better continuity

### Changed
- **Message streaming** — More reliable with fewer visual gaps between tools
- **Image handling** — Images stay in conversation context without needing to re-upload
- **Document annotations** — Now properly saved and used in responses

---

## [0.4.1] - 2025-12-19

### Changed
- Improved how default models are selected

---

## [0.4.0] - 2025-12-19

### Added
- **Web search** — The assistant can now search the internet for current information
- **Deeper research** — AI can now think, search, think again in cycles for more thorough research
- Gemini 3 Flash Preview model
- Qwen3-Next Instruct model
- Qwen3-VL-235b Instruct model
- **Keyboard shortcuts** — Navigate faster with keyboard commands
- **Better tool display** — Reasoning and tool use now show in clean, collapsible widgets

---

## [0.3.1] - 2025-12-06

### Changed
- **File size limit** — Reduced from 20MB to 4.5MB to comply with hosting limits
- **Image optimization** — Images are automatically converted to WebP and resized to fit within limits

### Added
- **Drag and drop** — Drag images directly into the chat
- **Paste images** — Paste from clipboard to quickly share screenshots

---

## [0.3.0] - 2025-12-06

### Added
- **File uploads** — Attach images (PNG, JPG, WebP, GIF) and PDFs to your messages

---

## [0.2.1] - 2025-12-04

### Fixed
- Math equations now render correctly with proper fonts

---

## [0.2.0] - 2025-12-04

### Added
- **Smart memory** — Only relevant memories are included in conversations (using vector embeddings)
- **Global memories** — Mark important facts to always include in every conversation
- **New chat button** — Quick access in the top bar

### Changed
- **Refreshed UI** — Cleaner message input and button designs

### Fixed
- Various UI bugs
- Chat storage and creation issues
- Model selection improvements

---

## [0.1.0] - 2025-11-25

### Added
- **Initial release** of Libre Assistant
- Chat with multiple AI models
- Markdown support with syntax highlighting
- Math equation rendering (LaTeX/KaTeX)
- Task lists in messages
- Local chat history storage
- Custom user preferences and instructions
- Incognito mode for private chats
- Global memory system
- Web grounding capabilities