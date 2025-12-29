import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
    { ignores: ["dist", "node_modules", "coverage"] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ["**/*.tsx", "**/*.ts"],
        languageOptions: {
            ecmaVersion: 2020,
            globals: {
                ...globals.browser,
            },
        },
        plugins: {
            react: reactPlugin,
            "react-hooks": reactHooks,
        },
        rules: {
            "react/react-in-jsx-scope": "off",
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        },
        settings: {
            react: {
                version: "detect",
            },
        },
    }
);
