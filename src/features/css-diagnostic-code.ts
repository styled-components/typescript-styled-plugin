export const CSS_DIAGNOSTIC_CODE = 9999

/**
 * vscode-css-languageservice's stable parse-error id for "at-rule or selector expected"
 * (ParseError.RuleOrSelectorExpected, cssErrors.ts). At the template end it reports the wrapper's
 * own closing brace: the stray closing brace rule in docs/architecture.md, "Diagnostics".
 */
export const RULE_OR_SELECTOR_EXPECTED_DIAGNOSTIC_CODE = 'css-ruleorselectorexpected'
