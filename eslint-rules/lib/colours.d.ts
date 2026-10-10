// Types of eslint-rules/lib/colours.js (plain JavaScript, so that eslint.config.js can load the rules
// without a TypeScript loader).
export declare const NAMED_COLOURS: ReadonlySet<string>;
export declare function isColourProperty(name: string): boolean;
export declare function findNamedColourWords(value: string): { word: string; index: number }[];
export declare function argumentsOf(text: string, openIndex: number): string;
export declare function referencesToken(args: string): boolean;
export declare function isReferenceAttribute(name: string): boolean;
