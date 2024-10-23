const core = require("@actions/core");
const { CodeReviewBot } = require("./src/code-review-bot");
const { parseExcludePatterns } = require("./src/utils");

async function run() {
  try {
    // Obtener configuración
    const config = {
      githubToken: core.getInput("github-token", { required: true }),
      awsConfig: {
        region: core.getInput("aws-region", { required: true }),
      },
      excludePatterns: parseExcludePatterns(core.getInput("exclude-patterns")),
      maxFiles: parseInt(core.getInput("max-files")) || 10,
      commentThreshold: core.getInput("comment-threshold") || "MEDIA",
    };

    const bot = new CodeReviewBot(config);
    await bot.run();
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
