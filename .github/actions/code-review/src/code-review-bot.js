const github = require("@actions/github");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { DiffParser } = require("./diff-parser");
const { shouldAnalyzeFile, severityLevel } = require("./utils");

class CodeReviewBot {
  constructor(config) {
    this.config = config;
    this.octokit = github.getOctokit(config.githubToken);
    this.bedrock = new BedrockRuntimeClient(config.awsConfig);
    this.context = github.context;
    this.diffParser = new DiffParser();
  }

  async run() {
    if (this.context.eventName === "pull_request") {
      await this.handlePullRequest();
    } else if (this.context.eventName === "issue_comment") {
      await this.handleComment();
    }
  }

  async getPRFiles() {
    const { data: files } = await this.octokit.rest.pulls.listFiles({
      ...this.context.repo,
      pull_number: this.context.payload.pull_request.number,
    });
    return files;
  }

  async handlePullRequest() {
    const files = await this.getPRFiles();
    let analyzedFiles = 0;

    for (const file of files) {
      if (analyzedFiles >= this.config.maxFiles) {
        break;
      }

      if (!shouldAnalyzeFile(file.filename, this.config.excludePatterns)) {
        continue;
      }

      const content = await this.getFileContent(file.filename);
      const analysis = await this.analyzeCode(content, file.filename);
      console.log("Analysis:", analysis);
      await this.createReviewComments(file.filename, analysis);
      analyzedFiles++;
    }
  }

  async handleComment() {
    const comment = this.context.payload.comment;
    if (comment.body.trim() === "/apply-fix") {
      await this.handleApplyFix(comment);
    }
  }

  async analyzeCode(content, filename) {
    const prompt = this.buildPrompt(content, filename);
    const response = await this.invokeClaude(prompt);
    return this.parseAnalysis(response);
  }

  buildPrompt(content, filename) {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `Analiza el siguiente código y proporciona un análisis detallado. 
                Enfócate en:
                1. Bugs potenciales o actuales
                2. Vulnerabilidades de seguridad
                3. Problemas de rendimiento
                4. Mejores prácticas específicas para ${filename
                  .split(".")
                  .pop()}
                5. Sugerencias de refactorización

                Para cada problema identificado:
                - Indica la línea específica del código
                - Explica el problema
                - Proporciona una solución concreta con el código corregido
                - Clasifica la severidad (CRÍTICA, ALTA, MEDIA, BAJA)
                - Si es posible, incluye referencias a documentación relevante

                Archivo: ${filename}
                Contenido:
                ${content}

                Formato de respuesta:
                Para cada problema, usa el siguiente formato JSON:
                {
                  "line": número_de_línea,
                  "severity": "CRÍTICA|ALTA|MEDIA|BAJA",
                  "issue": "descripción del problema",
                  "suggestion": "sugerencia de solución",
                  "code": "código corregido",
                  "refs": ["enlaces a documentación"],
                  "canAutoFix": true|false
                }`,
        },
      ],
    };
  }

  async invokeClaude(prompt) {
    const payload = {
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages: [prompt],
      }),
    };

    const command = new InvokeModelCommand(payload);
    const response = await this.bedrock.send(command);
    return JSON.parse(new TextDecoder().decode(response.body));
  }

  async createReviewComments(path, analysis) {
    const filteredIssues = analysis.filter(
      (issue) =>
        severityLevel(issue.severity) >=
        severityLevel(this.config.commentThreshold)
    );

    for (const issue of filteredIssues) {
      const commentBody = this.formatComment(issue);
      await this.createComment(path, commentBody, issue.line);
    }
  }

  formatComment(issue) {
    return `
🤖 **Análisis de Código por Claude**

**Severidad**: ${issue.severity}
**Problema**: ${issue.issue}
**Sugerencia**: ${issue.suggestion}

\`\`\`diff
${issue.code}
\`\`\`

${
  issue.canAutoFix
    ? "¿Deseas que aplique este cambio? Responde con `/apply-fix` para aplicarlo."
    : ""
}

Referencias:
${issue.refs.map((ref) => `- ${ref}`).join("\n")}
    `;
  }

  async getFileContent(path) {
    const { data } = await this.octokit.rest.repos.getContent({
      ...this.context.repo,
      path,
      ref: this.context.payload.pull_request.head.sha,
    });
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  parseAnalysis(response) {
    try {
      if (response.content && Array.isArray(response.content)) {
        // If content is directly an array
        return response.content.flatMap((item) => {
          if (item.text) {
            try {
              return JSON.parse(item.text);
            } catch (e) {
              console.warn("Couldn't parse item as JSON:", item.text);
              return [];
            }
          }
          return [];
        });
      } else if (response.messages && Array.isArray(response.messages)) {
        // If response has a messages array
        return response.messages.flatMap((message) => {
          if (message.content && Array.isArray(message.content)) {
            return message.content.flatMap((item) => {
              if (item.text) {
                try {
                  return JSON.parse(item.text);
                } catch (e) {
                  console.warn("Couldn't parse item as JSON:", item.text);
                  return [];
                }
              }
              return [];
            });
          }
          return [];
        });
      } else if (typeof response === "string") {
        // If response is a string, try to parse it directly
        return JSON.parse(response);
      } else {
        console.warn("Unexpected response structure:", response);
        return [];
      }
    } catch (error) {
      console.error("Error parsing analysis:", error);
      console.error("Raw response:", JSON.stringify(response, null, 2));
      return [];
    }
  }

  async createComment(path, body, line) {
    await this.octokit.rest.pulls.createReviewComment({
      ...this.context.repo,
      pull_number: this.context.payload.pull_request.number,
      body,
      path,
      line,
      commit_id: this.context.payload.pull_request.head.sha,
    });
  }

  async handleApplyFix(comment) {
    const pullRequestNumber = this.context.payload.issue.number;
    const reviewComments = await this.getReviewComments(pullRequestNumber);
    const fixComment = reviewComments.find(
      (rc) => rc.id === comment.in_reply_to_id
    );

    if (fixComment) {
      const { path, line, body } = fixComment;
      const fixCode = this.extractFixCode(body);
      if (fixCode) {
        await this.applyChanges(path, line, fixCode);
      }
    }
  }

  async getReviewComments(pullRequestNumber) {
    const { data: comments } = await this.octokit.rest.pulls.listReviewComments(
      {
        ...this.context.repo,
        pull_number: pullRequestNumber,
      }
    );
    return comments;
  }

  extractFixCode(commentBody) {
    const codeBlockRegex = /```diff\n([\s\S]*?)\n```/;
    const match = commentBody.match(codeBlockRegex);
    return match ? match[1] : null;
  }

  async applyChanges(path, line, fixCode) {
    const content = await this.getFileContent(path);
    const lines = content.split("\n");
    lines[line - 1] = fixCode.replace(/^[+-]\s/, "");
    const updatedContent = lines.join("\n");

    await this.octokit.rest.repos.createOrUpdateFileContents({
      ...this.context.repo,
      path,
      message: `Apply fix suggested by CodeReviewBot`,
      content: Buffer.from(updatedContent).toString("base64"),
      sha: this.context.payload.pull_request.head.sha,
      branch: this.context.payload.pull_request.head.ref,
    });
  }
}
module.exports = { CodeReviewBot };
