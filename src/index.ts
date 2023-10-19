/**
 * Code based on
 * https://developers.google.com/gmail/api/quickstart/nodejs
 */
import os from 'os';
import fs from "fs/promises";
import path from "path";
import {authenticate} from '@google-cloud/local-auth';
import { google} from 'googleapis';
import {gmail_v1} from "@googleapis/gmail";
import Gmail = gmail_v1.Gmail;
import {uniq} from "lodash";
import { RateLimiter } from "limiter";
import ClipProgress from "cli-progress";
import tmpfile from 'tmpfile';
import credentials from './credentials.json';
import domains from './domains.json';
import Schema$Message = gmail_v1.Schema$Message;

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const OUTPUT_PATH = path.join(os.homedir(), 'gmail-scraper-emails.txt');

const limiter = new RateLimiter({
    tokensPerInterval: 5,
    interval: "second"
});

let client: any;
async function authorize(): Promise<any> {
    if(client) return client;

    // Create temporary file for credentials (since google needs it in a file)
    const tmpFile = tmpfile({ extension: 'json' });
    await fs.writeFile(tmpFile, JSON.stringify(credentials, null, 4), 'utf8');

    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: tmpFile,
    });

    return client;
}

async function* getMessages(gmail: Gmail, search?: string, size = 450) {
    let cursor: any = undefined;
    let progress: ClipProgress.SingleBar | undefined;

    do {

        await limiter.removeTokens(1);
        const messageIds = await gmail.users.messages.list({
            includeSpamTrash: false,
            maxResults: size,
            q: search,
            userId: 'me',
            pageToken: cursor,
        });

        if(!progress && messageIds.data.resultSizeEstimate) {
            progress = new ClipProgress.SingleBar({
                hideCursor: true
            });
            progress.start(messageIds.data.resultSizeEstimate, 0, {
              speed: 'N/A'
            })
        }

        if (!messageIds?.data?.messages) {
            return;
        }

        const promises = messageIds.data.messages.map(async (id) => {
            if(!id?.id) return null;
            await limiter.removeTokens(1);
            const msg = gmail.users.messages.get({ id: id.id, userId: 'me' })
            msg.finally(() => progress?.increment());
            return msg;
        });

        const messages = await Promise.allSettled(promises);
        for(let message of messages) {
            if(message.status === 'fulfilled' && message?.value?.data) {
                yield message.value.data;
            }
        }

        cursor = messageIds.data.nextPageToken;
    } while(cursor);
}

function getMessageHeader(msg: Schema$Message|null|undefined, name: string): string | null {
    if(!msg) return null;
    return msg.payload?.headers?.find((h: any) => {
        return h.name.toLowerCase() === name.toLowerCase()
    })?.value ?? null;
}

function getMessageEmails(msg: Schema$Message|null|undefined) {
    const from = getMessageHeader(msg, 'from');
    const to = getMessageHeader(msg, 'to');
    let emails: string[] = [];
    if(from) emails = emails.concat(parseEmails(from));
    if(to) emails = emails.concat(parseEmails(to));
    return uniq(emails);
}

function parseEmails(str: string|null|undefined): string[] {
    if (!str) return [];

    const match = str.match(/([a-zA-Z0-9.+_-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
    if (!match) return [];

    const normalized = match.map((email) => {
        let nextEmail = email.toLowerCase();
        let [fullUsername, domain] = nextEmail.split('@');
        let [username, _tail] = fullUsername.replace(".", '').split("+");
        return `${username}@${domain}`;
    })

    return uniq(normalized);
}

function matchesDomains(email: string|null|undefined, domains: string[]) {
    if(!email) return false;
    return domains.some((domain) => {
        return email.toLowerCase().endsWith('@' + domain.toLowerCase())
    })
}

(async () => {
    const auth = await authorize();
    const gmail = google.gmail({version: 'v1', auth});
    const histogram: Record<string, number> = {};

    // Create the query
    const queryParts: string[] = [];
    for(let domain of domains) {
        queryParts.push(`from: @${domain}`);
        queryParts.push(`to: @${domain}`);
    }
    const search = queryParts.join(" OR ");

    // Prepare the output file
    try {
        await fs.truncate(OUTPUT_PATH);
    } catch(e) {
        // noop
    }
    const fh = await fs.open(OUTPUT_PATH, 'a');
    console.info(`Writing results to "${OUTPUT_PATH}"...`);
    console.info();
    console.info();

    const messages = getMessages(gmail, search)
    for await(let msg of messages) {
        const emails = getMessageEmails(msg);

        for(let email of emails) {
            if (matchesDomains(email, domains)) {
                histogram[email] = (histogram[email] || 0) + 1;
            }

            // If this is the first time we have seen this email, add it to the list
            if(histogram[email] === 1) {
                fh.write(email + '\n')
            }
        }
    }

    await fh.close();
    process.exit(0);
})();


