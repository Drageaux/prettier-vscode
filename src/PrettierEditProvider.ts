import * as prettier from "prettier";
import {
  CancellationToken,
  DocumentFormattingEditProvider,
  DocumentRangeFormattingEditProvider,
  FormattingOptions,
  Range,
  TextDocument,
  TextEdit
  // tslint:disable-next-line: no-implicit-dependencies
} from "vscode";
import { ConfigResolver, RangeFormattingOptions } from "./ConfigResolver";
import { IgnorerResolver } from "./IgnorerResolver";
import { LanguageResolver } from "./LanguageResolver";
import { LoggingService } from "./LoggingService";
import { ModuleResolver } from "./ModuleResolver";
import { NotificationService } from "./NotificationService";
import {
  IExtensionConfig,
  IPrettierStylelint,
  PrettierEslintFormat,
  PrettierTslintFormat
} from "./types.d";
import { getConfig, getWorkspaceRelativePath } from "./util";

export default class PrettierEditProvider
  implements
    DocumentRangeFormattingEditProvider,
    DocumentFormattingEditProvider {
  constructor(
    private moduleResolver: ModuleResolver,
    private ignoreResolver: IgnorerResolver,
    private configResolver: ConfigResolver,
    private loggingService: LoggingService,
    private notificationService: NotificationService
  ) {}

  public async provideDocumentRangeFormattingEdits(
    document: TextDocument,
    range: Range,
    options: FormattingOptions,
    token: CancellationToken
  ): Promise<TextEdit[]> {
    return this.provideEdits(document, {
      rangeEnd: document.offsetAt(range.end),
      rangeStart: document.offsetAt(range.start)
    });
  }

  public async provideDocumentFormattingEdits(
    document: TextDocument,
    options: FormattingOptions,
    token: CancellationToken
  ): Promise<TextEdit[]> {
    return this.provideEdits(document);
  }

  private async provideEdits(
    document: TextDocument,
    options?: RangeFormattingOptions
  ): Promise<TextEdit[]> {
    const hrstart = process.hrtime();
    const result = await this.format(document.getText(), document, options);
    if (!result) {
      // No edits happened, return never so VS Code can try other formatters
      return [];
    }
    const hrend = process.hrtime(hrstart);
    this.loggingService.logMessage(
      `Formatting completed in ${hrend[1] / 1000000}ms.`,
      "INFO"
    );
    return [TextEdit.replace(this.fullDocumentRange(document), result)];
  }

  /**
   * Format the given text with user's configuration.
   * @param text Text to format
   * @param path formatting file's path
   * @returns {string} formatted text
   */
  private async format(
    text: string,
    { fileName, languageId, uri }: TextDocument,
    rangeFormattingOptions?: RangeFormattingOptions
  ): Promise<string | undefined> {
    this.loggingService.logMessage(`Formatting ${fileName}.`, "INFO");

    // LEGACY: Remove in version 4.x
    this.notificationService.warnIfLegacyConfiguration(uri);

    const vscodeConfig: IExtensionConfig = getConfig(uri);
    const prettierInstance = this.moduleResolver.getPrettierInstance(
      vscodeConfig.prettierPath,
      fileName,
      true /* warn if outdated */
    );
    const languageResolver = new LanguageResolver(prettierInstance);

    // This has to stay, as it allows to skip in sub workspaceFolders. Sadly noop.
    // wf1  (with "lang") -> glob: "wf1/**"
    // wf1/wf2  (without "lang") -> match "wf1/**"
    if (vscodeConfig.disableLanguages.includes(languageId)) {
      return;
    }

    const ignorePath = this.ignoreResolver.getIgnorePath(fileName);

    let fileInfo: prettier.FileInfoResult | undefined;
    if (fileName) {
      fileInfo = await prettierInstance.getFileInfo(fileName, { ignorePath });
      this.loggingService.logMessage("File Info:", "INFO");
      this.loggingService.logObject(fileInfo, "INFO");
    }

    if (fileInfo && fileInfo.ignored) {
      return;
    }

    let parser: prettier.BuiltInParserName | string | undefined;
    if (fileInfo && fileInfo.inferredParser) {
      parser = fileInfo.inferredParser;
    } else {
      this.loggingService.logMessage(
        "Parser not inferred, using VS Code language.",
        "WARN"
      );
      const dynamicParsers = languageResolver.getParsersFromLanguageId(
        languageId
      );
      this.loggingService.logObject(dynamicParsers, "INFO");
      if (dynamicParsers.length > 0) {
        parser = dynamicParsers[0];
        this.loggingService.logMessage(
          `Resolved parser to '${parser}'.`,
          "INFO"
        );
      }
    }

    if (!parser) {
      this.loggingService.logMessage(
        `Failed to resolve a parser, skipping file.`,
        "ERROR"
      );
      return;
    }

    const hasConfig = await this.configResolver.checkHasPrettierConfig(
      fileName
    );

    if (!hasConfig && vscodeConfig.requireConfig) {
      return;
    }

    const prettierOptions = await this.configResolver.getPrettierOptions(
      fileName,
      parser as prettier.BuiltInParserName,
      {
        config: vscodeConfig.configPath
          ? getWorkspaceRelativePath(fileName, vscodeConfig.configPath)
          : undefined,
        editorconfig: true
      },
      rangeFormattingOptions
    );

    this.loggingService.logMessage("Prettier Options:", "INFO");
    this.loggingService.logObject(prettierOptions, "INFO");

    if (parser === "typescript") {
      const prettierTslintModule = this.moduleResolver.getModuleInstance(
        fileName,
        "prettier-tslint"
      );

      if (prettierTslintModule) {
        return this.safeExecution(
          () => {
            const prettierTslintFormat = prettierTslintModule.format as PrettierTslintFormat;

            return prettierTslintFormat({
              fallbackPrettierOptions: prettierOptions,
              filePath: fileName,
              text
            });
          },
          text,
          fileName
        );
      }
    }

    if (languageResolver.doesLanguageSupportESLint(languageId)) {
      const prettierEslintModule = this.moduleResolver.getModuleInstance(
        fileName,
        "prettier-eslint"
      );
      if (prettierEslintModule) {
        return this.safeExecution(
          () => {
            const prettierEslintFormat = prettierEslintModule as PrettierEslintFormat;

            return prettierEslintFormat({
              fallbackPrettierOptions: prettierOptions,
              filePath: fileName,
              text
            });
          },
          text,
          fileName
        );
      }
    }

    if (languageResolver.doesParserSupportStylelint(parser)) {
      const prettierStylelintModule = this.moduleResolver.getModuleInstance(
        fileName,
        "prettier-stylelint"
      );
      if (prettierStylelintModule) {
        const prettierStylelint = prettierStylelintModule as IPrettierStylelint;
        return this.safeExecution(
          prettierStylelint.format({
            filePath: fileName,
            prettierOptions,
            text
          }),
          text,
          fileName
        );
      }
    }

    return this.safeExecution(
      () => prettierInstance.format(text, prettierOptions),
      text,
      fileName
    );
  }

  /**
   * Execute a callback safely, if it doesn't work, return default and log messages.
   *
   * @param cb The function to be executed,
   * @param defaultText The default value if execution of the cb failed
   * @param fileName The filename of the current document
   * @returns {string} formatted text or defaultText
   */
  private safeExecution(
    cb: (() => string) | Promise<string>,
    defaultText: string,
    fileName: string
  ): string | Promise<string> {
    if (cb instanceof Promise) {
      return cb
        .then(returnValue => {
          return returnValue;
        })
        .catch((error: Error) => {
          this.loggingService.logError(error);

          return defaultText;
        });
    }
    try {
      const returnValue = cb();

      return returnValue;
    } catch (error) {
      this.loggingService.logError(error);

      return defaultText;
    }
  }

  private fullDocumentRange(document: TextDocument): Range {
    const lastLineId = document.lineCount - 1;
    return new Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
  }
}
