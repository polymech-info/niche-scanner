
import { z } from 'zod/v4'

export enum ResolveFlags {
    PHOTOS = 'PHOTOS',
}


// Base schema without transformation - allows merging
export const zodSchemaBase = () =>
    z.object(
        {
            api_key: z.string().optional().describe('API Key'),
            blacklist: z
                .array(z.string())
                .default(['bazar.preciousplastic.com'])
                .describe('A list of hostnames to exclude from the results').optional(),

            category: z.string().optional().default('category'),
            concurrency: z.number().default(3).describe('The concurrency level for async operations'),
            engine: z.string().default('google_maps'),
            filterCity: z.string().optional(),
            filterCountry: z.string().optional(),
            filterContinent: z.string().optional(),
            filterType: z.string().optional(),

            geocode_key: z.string().optional(),
            google_domain: z.string().default('google.com'),

            language: z.string().default('en'),
            limit: z.number().default(250),



            query: z.string().default('plastichub'),
            resolve: z.array(z.nativeEnum(ResolveFlags)).default([ResolveFlags.PHOTOS]).optional(),
            searchCoord: z.string().optional(),
            searchFrom: z.string().optional().default('barcelona, spain'),

            type: z.string().optional().default('search'),
            zoom: z.number().optional().default(12),
            excludedTypes: z.array(z.string()).optional().describe('Types to exclude'),
            variables: z.any().optional(),
        }).loose()

// Schema with transformation applied
export const zodSchema = () =>
    zodSchemaBase()



export type IOptionsGoogleMaps = z.infer<ReturnType<typeof zodSchema>>
export type IOptionsGoogleMapsInput = z.input<ReturnType<typeof zodSchema>>


export const meta_schema = z.object({
    og: z.object({
        url: z.string(),
        type: z.string(),
        title: z.string(),
        site_name: z.string()
    }),
    meta: z.object({ url: z.string(), title: z.string() }),
    links: z.array(z.unknown()),
    images: z.array(z.object({ src: z.string() })),
    allLinks: z.array(z.string()),
    keywords: z.array(z.unknown()),
    instagram: z.string(),
    structured: z.array(
        z.object({
            "@graph": z.array(
                z.union([
                    z.object({
                        "@id": z.string(),
                        url: z.string(),
                        name: z.string(),
                        "@type": z.string(),
                        isPartOf: z.object({ "@id": z.string() }),
                        breadcrumb: z.object({ "@id": z.string() }),
                        inLanguage: z.string(),
                        dateModified: z.string(),
                        datePublished: z.string(),
                        potentialAction: z.array(
                            z.object({ "@type": z.string(), target: z.array(z.string()) })
                        )
                    }),
                    z.object({
                        "@id": z.string(),
                        "@type": z.string(),
                        itemListElement: z.array(
                            z.object({
                                name: z.string(),
                                "@type": z.string(),
                                position: z.number()
                            })
                        )
                    }),
                    z.object({
                        "@id": z.string(),
                        url: z.string(),
                        name: z.string(),
                        "@type": z.string(),
                        inLanguage: z.string(),
                        description: z.string(),
                        potentialAction: z.array(
                            z.object({
                                "@type": z.string(),
                                target: z.object({
                                    "@type": z.string(),
                                    urlTemplate: z.string()
                                }),
                                "query-input": z.object({
                                    "@type": z.string(),
                                    valueName: z.string(),
                                    valueRequired: z.boolean()
                                })
                            })
                        )
                    })
                ])
            ),
            "@context": z.string()
        })
    )
})
