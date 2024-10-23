const { minimatch } = require("minimatch");

function parseExcludePatterns(input) {
  if (!input) return [];
  return input
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

function shouldAnalyzeFile(filename, excludePatterns) {
  return !excludePatterns.some((pattern) => minimatch(filename, pattern));
}

function severityLevel(severity) {
  const levels = {
    CRÍTICA: 4,
    ALTA: 3,
    MEDIA: 2,
    BAJA: 1,
  };
  return levels[severity] || 0;
}

module.exports = {
  parseExcludePatterns,
  shouldAnalyzeFile,
  severityLevel,
};
