import type { Writable } from 'svelte/store';
import { writable } from 'svelte/store';
import type { Web3File } from '../ipfs-service';
import type { CollectSettings } from '../publications/CollectSettings';
import type { PostDraft } from '../publications/PostDraft';
import type { AnyMedia } from '@lens-protocol/metadata';

export interface Recipient {
    address: string;
    split: number;
    identity?: {
        lens?: string;
        ens?: string;
    };
}

export enum PublicationState {
    /**
     * Transaction submitted
     */
    SUBMITTED = 'SUBMITTED',

    /**
     * Transaction successful
     */
    SUCCESS = 'SUCCESS',

    /**
     * Index pending
     */
    PENDING = 'PENDING',

    /**
     * There was an error during indexing
     */
    ERROR = 'ERROR',
}

/**
 * The post unique id, used for drafts
 */
export const draftId: Writable<string | undefined> = writable();

/**
 * The post title, used as the NFT name
 */
export const title: Writable<string | undefined> = writable();

/**
 * The post content
 */
export const content: Writable<string | undefined> = writable();

/**
 * The NFT description
 */
export const description: Writable<string | undefined> = writable();

/**
 * A file ready for uploading and transformation into an attachment
 */
export const file: Writable<Web3File | undefined> = writable();

/**
 * The post attachments. An array of image, audio, and/or video files.
 */
export const attachments: Writable<AnyMedia[] | undefined> = writable();

/**
 * The cover image for audio and video attachments
 */
export const cover: Writable<Web3File | undefined> = writable();

/**
 * The author attribute in audio NFT metadata
 */
export const author: Writable<string | undefined> = writable();

/**
 * The collect module settings when set to one of the fee types
 */
export const collectSettings: Writable<CollectSettings> = writable({});

/**
 * Used for optimistic display while waiting to be indexed
 */
export const publicationState: Writable<PublicationState | undefined> =
    writable();

/**
 * The content tags
 */
export const tags: Writable<string[] | undefined> = writable();

// export const contentWarning: Writable<PublicationContentWarning | undefined> =
//     writable();

/**
 * Clears all post-related stores
 */
export const clearPostState = () => {
    draftId.set(undefined);
    title.set(undefined);
    content.set(undefined);
    description.set(undefined);
    attachments.set(undefined);
    cover.set(undefined);
    author.set(undefined);
    collectSettings.set({});
    tags.set(undefined);
    // contentWarning.set(undefined);
};

export const loadFromDraft = (postDraft: PostDraft) => {
    if (!postDraft) return;
    draftId.set(postDraft.id);
    title.set(postDraft.title);
    content.set(postDraft.content);
    description.set(postDraft.description);
    attachments.set(postDraft.attachments);
    author.set(postDraft.author);
    collectSettings.set(postDraft.collectFee ?? {});
    tags.set(postDraft.tags);
    // contentWarning.set(postDraft.contentWarning);
};
