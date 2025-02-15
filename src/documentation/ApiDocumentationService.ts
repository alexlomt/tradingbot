import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';
import { join } from 'path';
import * as fs from 'fs/promises';
import { MetricsService } from '../services/metrics/MetricsService';
import { OpenAPIObject } from '@nestjs/swagger';
import { APIVersion, DocumentationConfig } from '../types/documentation.types';

@Injectable()
export class ApiDocumentationService implements OnModuleInit {
    private currentSpec: OpenAPIObject;
    private readonly docsPath: string;
    private readonly versions: APIVersion[] = ['v1', 'v2'];

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService
    ) {
        this.docsPath = join(process.cwd(), 'documentation');
    }

    async onModuleInit() {
        await this.validateDocumentationFiles();
        await this.generateStaticDocs();
    }

    async setupSwagger(app: INestApplication): Promise<void> {
        for (const version of this.versions) {
            const config = this.getSwaggerConfig(version);
            const document = SwaggerModule.createDocument(app, config);
            
            await this.validateApiSpec(document, version);
            await this.saveApiSpec(document, version);

            SwaggerModule.setup(`api/${version}/docs`, app, document, {
                explorer: true,
                swaggerOptions: {
                    persistAuthorization: true,
                    tagsSorter: 'alpha',
                    operationsSorter: 'alpha',
                    docExpansion: 'none',
                    filter: true,
                    tryItOutEnabled: true
                },
                customCss: await this.getCustomCss(),
                customJs: await this.getCustomJs(),
                customSiteTitle: `Trading Bot API ${version.toUpperCase()} Documentation`
            });

            this.currentSpec = document;
        }
    }

    private getSwaggerConfig(version: APIVersion) {
        return new DocumentBuilder()
            .setTitle('Trading Bot API')
            .setDescription(this.getApiDescription())
            .setVersion(version)
            .addBearerAuth()
            .addApiKey()
            .addTag('Trading', 'Endpoints for trading operations')
            .addTag('Market Data', 'Endpoints for market data operations')
            .addTag('User Management', 'Endpoints for user management')
            .addTag('System', 'Endpoints for system operations')
            .addServer({
                url: this.configService.get('API_URL'),
                description: 'Production API Server'
            })
            .addServer({
                url: this.configService.get('STAGING_API_URL'),
                description: 'Staging API Server'
            })
            .build();
    }

    private getApiDescription(): string {
        return `
# Trading Bot API Documentation

## Overview
This API provides comprehensive access to the Trading Bot platform, enabling automated trading, market data access, and system management.

## Authentication
All API requests require authentication using either:
- Bearer token (JWT)
- API key in the request header

## Rate Limiting
- Public endpoints: 100 requests per minute
- Private endpoints: 300 requests per minute
- Trading endpoints: 50 requests per minute

## Versioning
APIs are versioned using URL path versioning (e.g., /v1/, /v2/)

## Response Formats
All responses are in JSON format and follow the structure:
\`\`\`json
{
    "success": boolean,
    "data": object | array,
    "error": string | null,
    "timestamp": string
}
\`\`\`

## Error Handling
Error responses include detailed error messages and codes for debugging.

## Webhooks
Webhook notifications are available for trade executions, price alerts, and system events.
        `;
    }

    private async validateApiSpec(
        document: OpenAPIObject,
        version: APIVersion
    ): Promise<void> {
        const endpoints = this.extractEndpoints(document);
        const validationResults = await this.validateEndpoints(endpoints, version);

        if (validationResults.length > 0) {
            await this.recordValidationErrors(validationResults, version);
        }
    }

    private async saveApiSpec(
        document: OpenAPIObject,
        version: APIVersion
    ): Promise<void> {
        const specPath = join(this.docsPath, version, 'swagger.json');
        await fs.writeFile(
            specPath,
            JSON.stringify(document, null, 2),
            'utf8'
        );

        await this.generatePostmanCollection(document, version);
    }

    private async generatePostmanCollection(
        document: OpenAPIObject,
        version: APIVersion
    ): Promise<void> {
        const postmanData = this.convertToPostmanFormat(document);
        const collectionPath = join(
            this.docsPath,
            version,
            'postman_collection.json'
        );

        await fs.writeFile(
            collectionPath,
            JSON.stringify(postmanData, null, 2),
            'utf8'
        );
    }

    private async validateDocumentationFiles(): Promise<void> {
        for (const version of this.versions) {
            const versionPath = join(this.docsPath, version);
            await fs.mkdir(versionPath, { recursive: true });

            const requiredFiles = ['schemas', 'examples', 'security'];
            for (const dir of requiredFiles) {
                await fs.mkdir(join(versionPath, dir), { recursive: true });
            }
        }
    }

    private async generateStaticDocs(): Promise<void> {
        for (const version of this.versions) {
            await this.generateVersionDocs(version);
        }
    }

    private async generateVersionDocs(version: APIVersion): Promise<void> {
        const config: DocumentationConfig = {
            version,
            outputPath: join(this.docsPath, version, 'static'),
            templates: join(this.docsPath, 'templates'),
            examples: join(this.docsPath, version, 'examples')
        };

        await this.generateMarkdownDocs(config);
        await this.generatePdfDocs(config);
    }

    private async getCustomCss(): Promise<string> {
        return `
            .swagger-ui .topbar { display: none }
            .swagger-ui .info { margin: 20px 0 }
            .swagger-ui .scheme-container { margin: 0 }
            .swagger-ui .info .title small { display: none }
            .swagger-ui .info__contact { display: none }
            .swagger-ui .info__license { display: none }
        `;
    }

    private async getCustomJs(): Promise<string> {
        return `
            window.onload = function() {
                const mutationObserver = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        if (mutation.target.classList && mutation.target.classList.contains('response')) {
                            const responseElement = mutation.target;
                            const statusCode = responseElement.querySelector('.response-col_status');
                            if (statusCode && statusCode.textContent) {
                                const code = parseInt(statusCode.textContent);
                                if (code >= 400) {
                                    responseElement.style.backgroundColor = '#fff1f0';
                                } else if (code >= 200 && code < 300) {
                                    responseElement.style.backgroundColor = '#f6ffed';
                                }
                            }
                        }
                    });
                });

                mutationObserver.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            };
        `;
    }

    private extractEndpoints(document: OpenAPIObject): any[] {
        const endpoints = [];
        const paths = document.paths;

        for (const path in paths) {
            const methods = paths[path];
            for (const method in methods) {
                endpoints.push({
                    path,
                    method: method.toUpperCase(),
                    operation: methods[method]
                });
            }
        }

        return endpoints;
    }

    private async validateEndpoints(
        endpoints: any[],
        version: APIVersion
    ): Promise<any[]> {
        const validationResults = [];

        for (const endpoint of endpoints) {
            const validation = await this.validateEndpoint(endpoint, version);
            if (validation.errors.length > 0) {
                validationResults.push({
                    endpoint: `${endpoint.method} ${endpoint.path}`,
                    errors: validation.errors
                });
            }
        }

        return validationResults;
    }

    private async validateEndpoint(
        endpoint: any,
        version: APIVersion
    ): Promise<any> {
        const errors = [];

        // Validate required fields
        if (!endpoint.operation.summary) {
            errors.push('Missing summary');
        }
        if (!endpoint.operation.description) {
            errors.push('Missing description');
        }
        if (!endpoint.operation.responses['200']) {
            errors.push('Missing success response');
        }

        // Validate parameters
        if (endpoint.operation.parameters) {
            for (const param of endpoint.operation.parameters) {
                if (!param.description) {
                    errors.push(`Parameter ${param.name} missing description`);
                }
            }
        }

        // Validate response schemas
        const responses = endpoint.operation.responses;
        for (const code in responses) {
            const response = responses[code];
            if (!response.content?.['application/json']?.schema) {
                errors.push(`Response ${code} missing schema`);
            }
        }

        return { errors };
    }

    private async recordValidationErrors(
        errors: any[],
        version: APIVersion
    ): Promise<void> {
        await this.metricsService.recordApiValidationErrors({
            version,
            errors,
            timestamp: new Date()
        });
    }

    private convertToPostmanFormat(document: OpenAPIObject): any {
        return {
            info: {
                name: `Trading Bot API - ${document.info.version}`,
                description: document.info.description,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
            },
            item: this.convertPathsToPostmanItems(document.paths)
        };
    }

    private convertPathsToPostmanItems(paths: any): any[] {
        const items = [];

        for (const path in paths) {
            const methods = paths[path];
            for (const method in methods) {
                const operation = methods[method];
                items.push({
                    name: operation.summary,
                    request: {
                        method: method.toUpperCase(),
                        url: {
                            raw: `{{baseUrl}}${path}`,
                            host: ['{{baseUrl}}'],
                            path: path.split('/').filter(Boolean)
                        },
                        description: operation.description,
                        header: this.getPostmanHeaders(operation),
                        body: this.getPostmanBody(operation)
                    }
                });
            }
        }

        return items;
    }

    private getPostmanHeaders(operation: any): any[] {
        const headers = [
            {
                key: 'Content-Type',
                value: 'application/json'
            }
        ];

        if (operation.security) {
            headers.push({
                key: 'Authorization',
                value: 'Bearer {{authToken}}'
            });
        }

        return headers;
    }

    private getPostmanBody(operation: any): any {
        if (!operation.requestBody) {
            return null;
        }

        const schema = operation.requestBody.content['application/json'].schema;
        return {
            mode: 'raw',
            raw: JSON.stringify(this.generateExampleFromSchema(schema), null, 2)
        };
    }

    private generateExampleFromSchema(schema: any): any {
        if (schema.example) {
            return schema.example;
        }

        if (schema.type === 'object') {
            const example = {};
            for (const prop in schema.properties) {
                example[prop] = this.generateExampleFromSchema(
                    schema.properties[prop]
                );
            }
            return example;
        }

        return null;
    }
}
