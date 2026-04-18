import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import json from "@eslint/json";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

const extensionGlobals = {
  ...globals.browser,
  ...globals.serviceworker,
  ...globals.webextensions,
  browser: "readonly",
  chrome: "readonly",
};

const maintainabilityRules = {
  complexity: ["warn", { max: 15 }],
  "max-depth": ["warn", 4],
  "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
  "max-lines-per-function": [
    "warn",
    { max: 120, skipBlankLines: true, skipComments: true, IIFEs: false },
  ],
  "max-nested-callbacks": ["warn", 4],
  "max-params": ["warn", 4],
  "max-statements": ["warn", { max: 80 }],
};

const strictCorrectnessRules = {
  "array-callback-return": "error",
  "block-scoped-var": "error",
  curly: ["warn", "multi-line"],
  eqeqeq: ["error", "always", { null: "ignore" }],
  "guard-for-in": "error",
  "no-alert": "off",
  "no-caller": "error",
  "no-console": ["warn", { allow: ["warn", "error"] }],
  "no-else-return": ["error", { allowElseIf: false }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-eval": "error",
  "no-extend-native": "off",
  "no-extra-bind": "error",
  "no-implicit-coercion": ["error", { allow: ["!!"] }],
  "no-implied-eval": "error",
  "no-iterator": "error",
  "no-labels": "error",
  "no-lone-blocks": "error",
  "no-multi-assign": "error",
  "no-new-func": "error",
  "no-new-wrappers": "error",
  "no-object-constructor": "error",
  "no-octal-escape": "error",
  "no-promise-executor-return": "error",
  "no-proto": "error",
  "no-restricted-globals": [
    "error",
    {
      name: "open",
      message: "Use an explicit window.open reference so popup/browser intent is clear.",
    },
  ],
  "no-return-assign": "error",
  "no-script-url": "error",
  "no-self-compare": "error",
  "no-sequences": "error",
  "no-throw-literal": "error",
  "no-unmodified-loop-condition": "error",
  "no-unneeded-ternary": "error",
  "no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  "no-useless-call": "error",
  "no-useless-concat": "error",
  "no-var": "error",
  "object-shorthand": ["error", "always", { avoidQuotes: true }],
  "one-var": ["error", "never"],
  "operator-assignment": ["error", "always"],
  "prefer-const": ["error", { destructuring: "all" }],
  "prefer-template": "warn",
  radix: "error",
  "require-atomic-updates": "warn",
  "sort-imports": ["error", { ignoreDeclarationSort: false }],
  strict: "off",
  yoda: "error",
};

export default [
  includeIgnoreFile(gitignorePath),
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: extensionGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...strictCorrectnessRules,
      ...maintainabilityRules,
    },
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...strictCorrectnessRules,
      "sort-imports": "off",
    },
  },
  {
    files: ["playwright.config.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
      "no-console": "off",
      strict: "off",
    },
  },
  {
    files: ["**/*.json"],
    ignores: ["package-lock.json"],
    language: "json/json",
    ...json.configs.recommended,
  },
];
