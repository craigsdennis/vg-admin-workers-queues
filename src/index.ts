import { Hono } from 'hono';
import { stripIndents } from 'common-tags';

const app = new Hono<{ Bindings: Env }>();

type GatherMessage = {
	offset: number;
	limit: number;
};

function chunkArrayLoop(array: any[], size: number) {
    let result = [];
    for (let i = 0; i < array.length; i += size) {
        let chunk = [];
        for (let j = i; j < i + size && j < array.length; j++) {
            chunk.push(array[j]);
        }
        result.push(chunk);
    }
    return result;
}

app.get('/init', async (c) => {
	const UPPER = 300000;
	let offset = 50000;
	const limit = 500;
	const gatherRequests: MessageSendRequest<GatherMessage>[] = [];

	while (offset <= UPPER) {
		gatherRequests.push({body: { offset, limit }});
		offset += limit;
	}
	const batches = chunkArrayLoop(gatherRequests, 4);
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		console.log(`Sending batch to GATHERER_QUEUE of ${batch.length} starting with ${batch[0].body}`);
		await c.env.GATHERER_QUEUE.sendBatch(batch, {delaySeconds: i});
	}
	return c.json({ offset, limit });
});

app.get('/query', async (c) => {
	const query = c.req.query('q');
	const results = await c.env.AI.run('@cf/baai/bge-large-en-v1.5', {
		text: [query],
	});
	const embedding = results.data[0];
	const matches = await c.env.VECTORIZE.query(embedding, {
		returnMetadata: 'all',
	});
	return c.json(matches);
});


type IndexMessage = {
	id: number;
	name: string;
	summary?: string;
	storyline?: string;
	url: string;
};

function chunkTextBySentences(text: string, maxSentences: number = 3): string[] {
	// Split the text into sentences using regex
	const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
	if (sentences === null || sentences.length === 0) {
		return [text];
	}
	// Chunk the sentences into groups based on maxSentences
	const chunks: string[] = [];
	for (let i = 0; i < sentences.length; i += maxSentences) {
		const chunk = sentences.slice(i, i + maxSentences).join(' ');
		chunks.push(chunk.trim());
	}
	return chunks;
}

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch<GatherMessage & IndexMessage>, env: Env) {
		switch (batch.queue) {
			case 'vg-gatherer':
				for (const msg of batch.messages) {
					const payload: GatherMessage = msg.body;

					console.log(`Fetching games with offset ${payload.offset}...`);
					const body = stripIndents`fields id,name,summary,storyline,url;
					sort id asc;
					limit ${payload.limit};
					offset ${payload.offset};
					`;
					const headers = {
						Accept: 'application/json',
						'Client-ID': env.TWITCH_CLIENT_ID,
						Authorization: `Bearer ${env.TWITCH_APP_ACCESS_TOKEN}`,
					};
					try {
						const response = await fetch('https://api.igdb.com/v4/games', {
							method: 'POST',
							headers,
							body,
						});
						if (!response.ok) {
							throw new Error(response.status + ": " + response.statusText);
						}
 						const json: Array<object> = await response.json();
						if (json.length > 0) {
							const games: MessageSendRequest<IndexMessage>[] = json.map((game) => {
								return { body: game };
							});
							for (const batch of chunkArrayLoop(games, 100)) {
								console.log(`Sending batch of ${batch.length} games to be indexed`);
								await env.INDEXER_QUEUE.sendBatch(batch);
							}
						}
						msg.ack();
					} catch(err) {
						console.log(`Error trying to gather ${err}`);
						msg.retry({ delaySeconds: 5 });
					}
				}
				break;
			case 'vg-indexer':
				// Go across the batch
				const vectors: VectorizeVector[] = [];
				for (const msg of batch.messages) {
					const game = msg.body;
					const wanted = ['name', 'summary', 'storyline'];
					for (const field of wanted) {
						if (game[field] === undefined) continue;
						const chunks = chunkTextBySentences(game[field], 3);
						if (chunks.length === 0) continue;
						try {
							const results = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
								text: chunks,
							});
							const embeddings = results.data;
							for (let i = 0; i < embeddings.length; i++) {
								let indexStr = '';
								if (embeddings.length > 1) {
									indexStr = `[${i}]`;
								}
								vectors.push({
									id: `igdb:${game.id}:${field}${indexStr}`,
									values: embeddings[i],
									metadata: {
										text: chunks[i],
										id: game.id,
										name: game.name,
										url: game.url,
										type: field,
									},
								});
							}
							msg.ack();
						} catch (err) {
							console.log(`Error for igdb:${game.id} indexing chunks with ${chunks}`, err);
							msg.retry();
						}
					}
				}
				console.log(`Upserting ${vectors.length}`);
				const upserted = await env.VECTORIZE.upsert(vectors);
				console.log('upserted', upserted);
				break;
		}
	},
};
