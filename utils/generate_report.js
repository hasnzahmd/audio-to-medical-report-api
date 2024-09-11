import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { RunCollectorCallbackHandler } from "langchain/callbacks";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { v4 as uuidv4 } from 'uuid';

const generateFromText = async ({ transcriptions, report_language: language, fields, clientID, client }) => {
    const { nova_transcription, whisper_transcription, assembly_ai_transcription, rev_ai_transcription } = transcriptions;
    try {
        if (!!nova_transcription && !!whisper_transcription) {
            const mergingContextResult = await client.query('SELECT * FROM public."constants" WHERE name = $1', ['transcriptionContext']);
            const generationContextResult = await client.query('SELECT * FROM public."constants" WHERE name = $1', ['generationContext']);
            // console.log(">> mergingContextResult.rows[0]: ", mergingContextResult.rows[0]);
            // console.log(">> generationContextResult.rows[0]: ", generationContextResult.rows[0]);

            const mergingContext = mergingContextResult.rows[0].value;
            const generationContext = generationContextResult.rows[0].value;

            const reportTemplateResult = await client.query('SELECT value FROM public."constants" WHERE name = $1', ["structured_report_template"]);
            const reportTemplateResponse = reportTemplateResult.rows[0].value;
            const reportTemplate = reportTemplateResponse.replace("{fields}", fields.join(', '));

            const mergingPrompt = PromptTemplate.fromTemplate(mergingContext);
            const generationPrompt = PromptTemplate.fromTemplate(generationContext);

            let generationModel, mergingModel;

            const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
            const OPENAI_MODEL = process.env.OPENAI_MODEL;

            const mergeConfig = JSON.parse(process.env.MERGE_CONFIG);
            const generationConfig = JSON.parse(process.env.GENERATION_CONFIG);

            const service_name = process.env.SERVICE_NAME;

            let totalCompletionTokens = 0;
            let totalPromptTokens = 0;

            if (service_name === 'anthropic') {
                mergeConfig.modelName = ANTHROPIC_MODEL;
                mergingModel = new ChatAnthropic({
                    ...mergeConfig,
                    callbacks: [
                        {
                            handleLLMEnd: (output, runId, parentRunId, tags) => {
                                const { input_tokens, output_tokens } = output.llmOutput?.usage;
                                totalPromptTokens += input_tokens ?? 0;
                                totalCompletionTokens += output_tokens ?? 0;
                            },
                        },
                    ]
                });

                generationConfig.modelName = ANTHROPIC_MODEL;
                generationModel = new ChatAnthropic({
                    ...generationConfig,
                    callbacks: [
                        {
                            handleLLMEnd: (output, runId, parentRunId, tags) => {
                                const { input_tokens, output_tokens } = output.llmOutput?.usage;
                                totalPromptTokens += input_tokens ?? 0;
                                totalCompletionTokens += output_tokens ?? 0;
                            },
                        },
                    ]
                });
            } else {
                mergeConfig.modelName = OPENAI_MODEL;
                mergingModel = new ChatOpenAI({
                    callbacks: [
                        {
                            handleLLMEnd: (output, runId, parentRunId, tags) => {
                                const { completionTokens, promptTokens, totalTokens } = output.llmOutput?.tokenUsage;
                                totalPromptTokens += promptTokens ?? 0;
                                totalCompletionTokens += completionTokens ?? 0;
                            },
                        },
                    ],
                    ...mergeConfig
                });

                generationConfig.modelName = OPENAI_MODEL;
                generationModel = new ChatOpenAI({
                    callbacks: [
                        {
                            handleLLMEnd: (output, runId, parentRunId, tags) => {
                                const { completionTokens, promptTokens, totalTokens } = output.llmOutput?.tokenUsage;
                                totalPromptTokens += promptTokens ?? 0;
                                totalCompletionTokens += completionTokens ?? 0;
                            },
                        },
                    ],
                    ...generationConfig
                });
            }

            const mergingChain = mergingPrompt.pipe(mergingModel).pipe(new StringOutputParser());
            const generationChain = generationPrompt.pipe(generationModel).pipe(new StringOutputParser());

            const runCollector = new RunCollectorCallbackHandler();

            const combinedChain = RunnableSequence.from([
                {
                    transcription: mergingChain,
                    language: (input) => input.language,
                    template: (input) => input.template,
                },
                generationChain,
            ]);

            const result = await combinedChain.invoke({
                nova_transcription: nova_transcription,
                whisper_transcription: whisper_transcription,
                rev_transcription: rev_ai_transcription,
                assembly_transcription: assembly_ai_transcription,
                language: language,
                template: reportTemplate,
            },
                { callbacks: [runCollector] }
            );

            if (!!result) {
                const runID = runCollector.tracedRuns[0].id;
                console.log('totalPromptTokens:', totalPromptTokens);
                console.log('totalCompletionTokens:', totalCompletionTokens);

                const id = uuidv4();
                const created_at = new Date();
                const queryResult = await client.query(
                    'INSERT INTO public."runs" (id, run_id, client_id, total_prompt_tokens, total_completion_tokens, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                    [id, runID, clientID, totalPromptTokens, totalCompletionTokens, created_at]
                );
                console.log('Query result:', queryResult.rows[0]);
                return result;
            }
        }
    } catch (error) {
        throw error;
    }
}

export async function generateStructuredReport(data) {
    try {
        console.log('\n>>>>>> Generating JSON response <<<<<<');
        const { client } = data;
        const response = await generateFromText(data);
        console.log('response: ', response);

        let content;
        if (response.startsWith("{")) {
            content = response;
        } else if (response.startsWith("```json")) {
            content = response.slice(7, -3);
        } else {
            content = response.replace(/<.*?>/g, "").trim();
            if(content.startsWith("```json")) {
                content = content.slice(7, -3);
            }
        }
        
        let structuredReport = JSON.parse(content);
        console.log('structured report:', structuredReport);
        console.log('\n>>>>>> Respone generated <<<<<<');
        client.release();
        return structuredReport;

    } catch (error) {
        console.error('Error generating structured report');
        throw error;
    }
}