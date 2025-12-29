const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.ts"],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-undef": "warn",
        },
    },
];
