export type APIVersion = 'v1' | 'v2';

export interface DocumentationConfig {
    version: APIVersion;
    outputPath: string;
    templates: string;
    examples: string;
}

export interface ValidationError {
    endpoint: string;
    errors: string[];
}

export interface ApiValidationMetrics {
    version: APIVersion;
    errors: ValidationError[];
    timestamp: Date;
}
