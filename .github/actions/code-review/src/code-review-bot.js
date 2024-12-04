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
    this.bedrockModelId = config.bedrockModelId;
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
    const response = await this.invokeBedrock(prompt);
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
              4. Mejores prácticas específicas para ${filename.split(".").pop()}
              5. Sugerencias de refactorización

              Para cada problema identificado, proporciona la información en el siguiente formato JSON exacto:

              {
                "line": <número_de_línea>,
                "severity": "<CRÍTICA|ALTA|MEDIA|BAJA>",
                "issue": "<descripción breve del problema>",
                "suggestion": "<sugerencia de solución>",
                "code": "<código corregido>",
                "refs": ["<enlace1>", "<enlace2>", ...],
                "canAutoFix": <true|false>
              }

              Instrucciones importantes:
              1. Responde SOLO con objetos JSON, uno por cada problema encontrado.
              2. No incluyas texto adicional fuera de los objetos JSON.
              3. Asegúrate de que cada objeto JSON esté en una línea separada.
              4. Si no encuentras problemas, responde con un array vacío: []

              Archivo: ${filename}
              Contenido:
              ${content}`,
        },
      ],
    };
  }

  async invokeBedrock(prompt) {
    const payload = {
      modelId: this.bedrockModelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1000,
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
🤖 **Análisis de Código por AI**

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
      let content = "";
      if (response.content && Array.isArray(response.content)) {
        content = response.content[0].text;
      } else if (response.messages && Array.isArray(response.messages)) {
        content = response.messages[0].content[0].text;
      } else if (typeof response === "string") {
        content = response;
      }

      if (!content) {
        console.warn("No content found in response");
        return [];
      }

      // Attempt to fix and parse the JSON objects
      const jsonObjects = content.match(/\{[\s\S]*?\}/g) || [];
      return jsonObjects
        .map((jsonString) => {
          try {
            // Replace newlines in the "code" field with escaped newlines
            jsonString = jsonString.replace(
              /("code":\s*")([^"]*)(")/,
              (match, p1, p2, p3) => {
                return p1 + p2.replace(/\n/g, "\\n") + p3;
              }
            );
            // Ensure the JSON object is properly closed
            if (!jsonString.endsWith("}")) {
              jsonString += "}";
            }
            return JSON.parse(jsonString);
          } catch (e) {
            console.warn("Couldn't parse item as JSON:", jsonString);
            // Attempt to extract useful information even if JSON parsing fails
            const extractField = (field) => {
              const match = jsonString.match(
                new RegExp(`"${field}":\\s*"([^"]*)"`)
              );
              return match ? match[1] : null;
            };
            return {
              line: parseInt(extractField("line")) || null,
              severity: extractField("severity"),
              issue: extractField("issue"),
              suggestion: extractField("suggestion"),
              code: extractField("code"),
              refs: [],
              canAutoFix: false,
            };
          }
        })
        .filter((item) => item !== null);
    } catch (error) {
      console.error("Error parsing analysis:", error);
      console.error("Raw response:", JSON.stringify(response, null, 2));
      return [];
    }
  }

  async createComment(path, body, line) {
    const { data: diff } = await this.octokit.rest.pulls.get({
      ...this.context.repo,
      pull_number: this.context.payload.pull_request.number,
      mediaType: {
        format: "diff",
      },
    });

    const parsedDiff = this.diffParser.parse(diff);
    const fileDiff = parsedDiff.find((file) => file.to === path);

    if (!fileDiff) {
      console.warn(`No diff found for file: ${path}`);
      return;
    }

    const diffLine = fileDiff.chunks
      .flatMap((chunk) => chunk.changes)
      .find((change) => change.lineNumber === line);

    if (!diffLine) {
      console.warn(`Line ${line} not found in diff for file: ${path}`);
      return;
    }

    await this.octokit.rest.pulls.createReviewComment({
      ...this.context.repo,
      pull_number: this.context.payload.pull_request.number,
      body,
      path,
      line: diffLine.lineNumber,
      side: "RIGHT",
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
