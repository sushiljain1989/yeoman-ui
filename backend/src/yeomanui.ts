import * as os from "os";
import * as path from "path";
import * as fsextra from "fs-extra";
import * as _ from "lodash";
import * as Environment from "yeoman-environment";
import * as inquirer from "inquirer";
import { ReplayUtils, ReplayState } from "./replayUtils";
const datauri = require("datauri");
const titleize = require('titleize');
const humanizeString = require('humanize-string');
import * as defaultImage from "./defaultImage";
import { YouiAdapter } from "./youi-adapter";
import { YouiLog } from "./youi-log";
import { YouiEvents } from "./youi-events";
import { IRpc } from "@sap-devx/webview-rpc/out.ext/rpc-common";
import Generator = require("yeoman-generator");
import { GeneratorType, GeneratorFilter } from "./filter";
import { IChildLogger } from "@vscode-logging/logger";
import {IPrompt} from "@sap-devx/yeoman-ui-types";


export interface IGeneratorChoice {
  name: string;
  prettyName: string;
  message: string;
  homepage: string;
  imageUrl?: string;
}

export interface IGeneratorQuestion {
  type: string;
  name: string;
  message: string;
  choices: IGeneratorChoice[];
}

export interface IQuestionsPrompt extends IPrompt{
  questions: any[];
}

export class YeomanUI {
  private static defaultMessage = 
    "Some quick example text of the generator description. This is a long text so that the example will look good.";
  private static YEOMAN_PNG = "yeoman.png";
  private static isWin32 = (process.platform === 'win32');
  private static readonly PROJECTS: string = path.join(os.homedir(), 'projects');
  private static readonly NODE_MODULES = 'node_modules';

  private static funcReplacer(key: any, value: any) {
    return _.isFunction(value) ? "__Function" : value;
  }

  private cwd: string;
  private rpc: IRpc;
  private youiEvents: YouiEvents;
  private outputChannel: YouiLog;
  private logger: IChildLogger;
  private genMeta: { [namespace: string]: Environment.GeneratorMeta };
  private youiAdapter: YouiAdapter;
  private gen: Generator | undefined;
  private promptCount: number;
  private currentQuestions: Environment.Adapter.Questions<any>;
  private genFilter: GeneratorFilter;
  private generatorName: string;
  private replayUtils: ReplayUtils;
  private customQuestionEventHandlers: Map<string, Map<string, Function>>;

  constructor(rpc: IRpc, youiEvents: YouiEvents, outputChannel: YouiLog, logger: IChildLogger, genFilter?: GeneratorFilter, outputPath: string = YeomanUI.PROJECTS) {
    this.rpc = rpc;
    if (!this.rpc) {
      throw new Error("rpc must be set");
    }
    this.generatorName = "";
    this.replayUtils = new ReplayUtils();
    this.youiEvents = youiEvents;
    this.outputChannel = outputChannel;
    this.logger = logger;
    this.rpc.setResponseTimeout(3600000);
    this.rpc.registerMethod({ func: this.receiveIsWebviewReady, thisArg: this });
    this.rpc.registerMethod({ func: this.runGenerator, thisArg: this });
    this.rpc.registerMethod({ func: this.evaluateMethod, thisArg: this });
    this.rpc.registerMethod({ func: this.toggleOutput, thisArg: this });
    this.rpc.registerMethod({ func: this.logError, thisArg: this });
    this.rpc.registerMethod({ func: this.back, thisArg: this });

    this.youiAdapter = new YouiAdapter(outputChannel, youiEvents);
    this.youiAdapter.setYeomanUI(this);
    this.promptCount = 0;
    this.genMeta = {};
    this.currentQuestions = {};
    this.setGenFilter(genFilter);
    this.customQuestionEventHandlers = new Map();
    this.setCwd(outputPath);
  }

  public registerCustomQuestionEventHandler(questionType: string, methodName: string, handler: Function): void {
    let entry: Map<string, Function> = this.customQuestionEventHandlers.get(questionType);
    if (entry === undefined) {
      this.customQuestionEventHandlers.set(questionType, new Map());
      entry = this.customQuestionEventHandlers.get(questionType);
    }
    entry.set(methodName, handler);
  }

  private getCustomQuestionEventHandler(questionType: string, methodName: string): Function {
    const entry: Map<string, Function> = this.customQuestionEventHandlers.get(questionType);
    if (entry !== undefined) {
      return entry.get(methodName);
    }
  }

  public setGenFilter(genFilter: GeneratorFilter) {
    this.genFilter = genFilter ? genFilter : GeneratorFilter.create();
  }

  public async logError(error: any, prefixMessage?: string) {
    let errorMessage = this.getErrorInfo(error);
    if (prefixMessage) {
      errorMessage = `${prefixMessage}\n${errorMessage}`;
    }

    this.logger.error(errorMessage);
    return errorMessage;
  }

  public async getGenerators(): Promise<IQuestionsPrompt> {
    // optimization: looking up generators takes a long time, so if generators are already loaded don't bother
    // on the other hand, we never look for newly installed generators...

    const promise: Promise<IQuestionsPrompt> = new Promise(resolve => {
      const env: Environment.Options = this.getEnv();
      env.lookup(async () => this.onEnvLookup(env, resolve, this.genFilter));
    });

    return promise;
  }

  public async runGenerator(generatorName: string) {
    this.generatorName = generatorName;
    // TODO: should create and set target dir only after user has selected a generator;
    // see issue: https://github.com/yeoman/environment/issues/55
    // process.chdir() doesn't work after environment has been created
    try {
      await fsextra.mkdirs(this.getCwd());
      const env: Environment = Environment.createEnv(undefined, {}, this.youiAdapter);
      const meta: Environment.GeneratorMeta = this.getGenMetadata(generatorName);
      // TODO: support sub-generators
      env.register(meta.resolved);

      const genNamespace = this.getGenNamespace(generatorName);
      const gen: any = env.create(genNamespace, {options: {logger: this.logger.getChildLogger({label: generatorName})}});
      // check if generator defined a helper function called setPromptsCallback()
      const setPromptsCallback = _.get(gen, "setPromptsCallback");
      if (setPromptsCallback) {
        setPromptsCallback(this.setPromptList.bind(this));
      }

      this.setGenInstall(gen);
      this.promptCount = 0;
      this.gen = (gen as Generator);
      this.gen.destinationRoot(this.getCwd());
      /* Generator.run() returns promise. Sending a callback is deprecated:
           https://yeoman.github.io/generator/Generator.html#run
         ... but .d.ts hasn't been updated for a while:
           https://www.npmjs.com/package/@types/yeoman-generator */
        this.gen.run((err) => {
        if (!err) {
          this.onGeneratorSuccess(generatorName, this.gen.destinationRoot());
        } 
      });
      this.gen.on('error', (error: any) => {
        this.onGeneratorFailure(generatorName, error);
      });
    } catch (error) {
      this.onGeneratorFailure(generatorName, error);
    }
  }

  public setState(messages: any): Promise<void> {
    return this.rpc ? this.rpc.invoke("setState", [messages]) : Promise.resolve();
  }

  /**
   * 
   * @param answers - partial answers for the current prompt -- the input parameter to the method to be evaluated
   * @param method
   */
  public async evaluateMethod(params: any[], questionName: string, methodName: string): Promise<any> {
    try {
      if (this.currentQuestions) {
        const relevantQuestion: any = _.find(this.currentQuestions, question => {
          return _.get(question, "name") === questionName;
        });
        if (relevantQuestion) {
          const customQuestionEventHandler: Function = this.getCustomQuestionEventHandler(relevantQuestion["guiType"], methodName);
          return _.isUndefined(customQuestionEventHandler) ? 
            await relevantQuestion[methodName].apply(this.gen, params) : 
            await customQuestionEventHandler.apply(this.gen, params);
        }
      }
    } catch (error) {
      const questionInfo = `Could not update method '${methodName}' in '${questionName}' question in generator '${this.gen.options.namespace}'`;
      const errorMessage = await this.logError(error, questionInfo);
      return Promise.reject(errorMessage);
    } 
  }

  public async receiveIsWebviewReady() {
    try {
      // TODO: loading generators takes a long time; consider prefetching list of generators
      const generators: IQuestionsPrompt = await this.getGenerators();
      const response: any = await this.rpc.invoke("showPrompt", [generators.questions, "select_generator"]);

      this.replayUtils.clear();
      await this.runGenerator(response.name);
    } catch (error) {
      this.logError(error);
    }
  }

  public toggleOutput(): boolean {
    return this.outputChannel.showOutput();
  }

  public logMessage(message: string): void {
    this.outputChannel.log(message);
  }

  public setCwd(cwd: string) {
    this.cwd = (cwd || YeomanUI.PROJECTS);
  }

  public getCwd(): string {
    return this.cwd;
  }

  public async showPrompt(questions: Environment.Adapter.Questions<any>): Promise<inquirer.Answers> {
    this.promptCount++;
    const promptName = this.getPromptName(questions);

    if (this.replayUtils.getReplayState() === ReplayState.Replaying) {
      return this.replayUtils.next(this.promptCount, promptName);
    } else if (this.replayUtils.getReplayState() === ReplayState.EndingReplay) {
      const prompts: IPrompt[] = this.replayUtils.stop(questions);
      this.setPromptList(prompts);
    }

    this.replayUtils.recall(questions);

    this.currentQuestions = questions;
    const mappedQuestions: Environment.Adapter.Questions<any> = this.normalizeFunctions(questions);
    if (_.isEmpty(mappedQuestions)) {
      return {};
    }

    const answers = await this.rpc.invoke("showPrompt", [mappedQuestions, promptName]);
    this.replayUtils.remember(questions, answers);
    return answers;
  }

  public back(partialAnswers: Environment.Adapter.Answers): void {
    this.replayUtils.start(this.currentQuestions, partialAnswers);
    this.runGenerator(this.generatorName);
  }

  private getPromptName(questions: Environment.Adapter.Questions<any>): string {
    const firstQuestionName = _.get(questions, "[0].name");
    return (firstQuestionName ? _.startCase(firstQuestionName) : `Step ${this.promptCount}`);
  }

  private onGeneratorSuccess(generatorName: string, destinationRoot: string) {
    const message = `The '${generatorName}' project has been generated.`;
    this.logger.debug("done running yeomanui! " + message + ` You can find it at ${destinationRoot}`);
    this.youiEvents.doGeneratorDone(true, message, destinationRoot);
  }

  private async onGeneratorFailure(generatorName: string, error: any) {
    const messagePrefix = `${generatorName} generator failed.`;
    const errorMessage: string = await this.logError(error, messagePrefix);
    this.youiEvents.doGeneratorDone(false, errorMessage);
  }

  private getEnv(): Environment.Options {
    const env: Environment.Options = Environment.createEnv();
    const envGetNpmPaths: () => any = env.getNpmPaths;
    const that = this;
    env.getNpmPaths = function (localOnly:boolean = false) {
      // Start with the local paths derived by cwd in vscode 
      // (as opposed to cwd of the plugin host process which is what is used by yeoman/environment)
      // Walk up the CWD and add `node_modules/` folder lookup on each level
      const parts: string[] = that.getCwd().split(path.sep);
      const localPaths = _.map(parts, (part, index) => {
        const resrpath = path.join(...parts.slice(0, index + 1), YeomanUI.NODE_MODULES);
        return YeomanUI.isWin32 ? resrpath : path.join(path.sep, resrpath);
      });
      const defaultPaths = envGetNpmPaths.call(this, localOnly);
      
      return  _.uniq(localPaths.concat(defaultPaths));
    };
    return env;
  }

  private setGenInstall(gen: any) {
    const originalPrototype = Object.getPrototypeOf(gen);
    const originalGenInstall = _.get(originalPrototype, "install");
    if (originalGenInstall && !originalPrototype._uiInstall) {
      originalPrototype._uiInstall = true;
      originalPrototype.install = () => {
        try {
          this.youiEvents.doGeneratorInstall();
          originalGenInstall.call(gen);
        } catch (error) {
          this.logError(error);
        } finally {
          originalPrototype.install = originalGenInstall;
          delete originalPrototype._uiInstall;
        }
      };
    }
  }

  private getErrorInfo(error: any) {
    if (_.isString(error)) {
      return error;
    } 

    const name = _.get(error, "name", "");
    const message = _.get(error, "message", "");
    const stack = _.get(error, "stack", "");

    return `name: ${name}\n message: ${message}\n stack: ${stack}\n string: ${error.toString()}\n`;
  }
  
  private async onEnvLookup(env: Environment.Options, resolve: any, filter?: GeneratorFilter) {
    this.genMeta = env.getGeneratorsMeta();
    const generatorNames: string[] = env.getGeneratorNames();
    const generatorChoicePromises = _.map(generatorNames, genName => {
      return this.getGeneratorChoice(genName, filter);
    });

    const generatorChoices = await Promise.all(generatorChoicePromises);
    const generatorQuestion: IGeneratorQuestion = {
      type: "generators",
      name: "name",
      message: "",
      choices: _.compact(generatorChoices)
    };
    resolve({ name: "Select Generator", questions: [generatorQuestion] });
  }

  private async getGeneratorChoice(genName: string, filter?: GeneratorFilter): Promise<IGeneratorChoice | undefined> {
    let packageJson: any;
    const genPackagePath: string = this.getGenMetaPackagePath(genName);
  
    try {
      packageJson = await this.getGenPackageJson(genPackagePath);
    } catch (error) {
      this.logError(error);
      return Promise.resolve(undefined);
    }

    const genFilter: GeneratorFilter = GeneratorFilter.create(_.get(packageJson, ["generator-filter"]));
    const typeEqual: boolean = (filter.type === GeneratorType.all || filter.type === genFilter.type);
    const categoriesHasIntersection: boolean = (_.isEmpty(filter.categories) || !_.isEmpty(_.intersection(filter.categories, genFilter.categories)));
    if (typeEqual && categoriesHasIntersection) {
      return this.createGeneratorChoice(genName, genPackagePath, packageJson);
    }

    return Promise.resolve(undefined);
  }

  private async createGeneratorChoice(genName: string, genPackagePath: string, packageJson: any): Promise<IGeneratorChoice> {
    let genImageUrl;

    try {
      genImageUrl = await datauri.promise(path.join(genPackagePath, YeomanUI.YEOMAN_PNG));
    } catch (error) {
      genImageUrl = defaultImage.default;
      this.logger.debug(error);
    }

    const genMessage = _.get(packageJson, "description", YeomanUI.defaultMessage);
    const genDisplayName = _.get(packageJson, "displayName", '');
    const genPrettyName = _.isEmpty(genDisplayName) ? titleize(humanizeString(genName)) : genDisplayName;
    const genHomepage = _.get(packageJson, "homepage", '');

    return {
      name: genName,
      prettyName: genPrettyName,
      message: genMessage,
      homepage: genHomepage,
      imageUrl: genImageUrl
    };
  }

  private async getGenPackageJson(genPackagePath: string): Promise<any> {
    const packageJsonString: string = await fsextra.readFile(path.join(genPackagePath, "package.json"), "utf8");
    return JSON.parse(packageJsonString);
  }

  private getGenMetaPackagePath(genName: string): string {
    return _.get(this.getGenMetadata(genName), "packagePath");
  }

  private getGenMetadata(genName: string): Environment.GeneratorMeta {
    const genNamespace = this.getGenNamespace(genName);
    const genMetadata = _.get(this, ["genMeta", genNamespace]);
    if (_.isNil(genMetadata)) {
      const debugMessage = `${genNamespace} generator metadata was not found.`;
      this.logger.debug(debugMessage);
    }
    return genMetadata;
  }

  private getGenNamespace(genName: string): string {
    return `${genName}:app`;
  }

  /**
   * 
   * @param quesions 
   * returns a deep copy of the original questions, but replaces Function properties with a placeholder
   * 
   * Functions are lost when being passed to client (using JSON.Stringify)
   * Also functions cannot be evaluated on client)
   */
  private normalizeFunctions(questions: Environment.Adapter.Questions<any>): Environment.Adapter.Questions<any> {
    this.addCustomQuestionEventHandlers(questions);
    return JSON.parse(JSON.stringify(questions, YeomanUI.funcReplacer));
  }

  private setPromptList(prompts: IPrompt[]): Promise<void> {
    const promptsToDisplay: IPrompt[] = prompts.map((prompt: IPrompt) => {
      return _.assign({ questions: [], name: "", description: ""}, prompt);
    });

    if (this.replayUtils.isReplaying) {
      this.replayUtils.setPrompts(promptsToDisplay);
    } else {
      return this.rpc.invoke("setPromptList", [promptsToDisplay]);
    }
  }
  
  private addCustomQuestionEventHandlers(questions: Environment.Adapter.Questions<any>): void {
    for (const question of (questions as any[])) {
      const questionHandlers = this.customQuestionEventHandlers.get(question["guiType"]);
      if (questionHandlers) {
        questionHandlers.forEach((handler, methodName) => {
          (question as any)[methodName] = handler;
        });
      }
    }
  }
}
