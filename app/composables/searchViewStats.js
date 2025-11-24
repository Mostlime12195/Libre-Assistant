/**
 * @file searchViewStats.js
 * @description Composable to calculate web page read statistics from executed tools only
 */

// Function to get formatted statistics string for display from executed tools only
function getFormattedStatsFromExecutedTools(executedTools) {
  let pageCount = 0;

  // Count from old executedTools format (for backward compatibility)
  if (executedTools && Array.isArray(executedTools)) {
    executedTools.forEach(tool => {
      // Count web page operations (type: "browser.open")
      if (tool.type === 'browser.open') {
        pageCount++;
      }
    });
  }

  // Display only if there are pages read
  if (pageCount > 0) {
    return `Read ${pageCount} web page${pageCount !== 1 ? 's' : ''}`;
  }

  return '';
}

export {
  getFormattedStatsFromExecutedTools
};