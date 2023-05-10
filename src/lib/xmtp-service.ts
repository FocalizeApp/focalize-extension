import {Client, type Conversation, DecodedMessage, SortDirection, Stream} from '@xmtp/xmtp-js';
import {getEnsFromAddress, getSigner} from './ethers-service';
import {Observable} from 'rxjs';
import type {Profile, ProfilesQuery} from './graph/lens-service';
import gqlClient from './graph/graphql-client';
import {KEY_MESSAGE_TIMESTAMPS, KEY_PROFILES, type MessageTimestampMap} from './stores/cache-store';
import {truncateAddress} from './utils';
import type {InvitationContext} from '@xmtp/xmtp-js/dist/types/src/Invitation';

const LENS_PREFIX = 'lens.dev/dm';

let client: Client;

export interface Peer {
    profile?: Profile;
    wallet?: {
        address: string;
        ens?: string | null;
    }
}

export interface Thread {
    conversation: Conversation;
    unread?: boolean;
    peer?: Peer;
    latestMessage?: DecodedMessage;
}

const buildStorageKey = (address: string): string => {
    return `xmtp-${address}`;
};

const loadKeys = async (address: string): Promise<Uint8Array | null> => {
    const storageKey = buildStorageKey(address);
    const storage = await chrome.storage.local.get(storageKey);
    const savedKeys = storage[storageKey];
    return savedKeys ? Buffer.from(savedKeys, 'binary') : null;
};

const storeKeys = async (address: string, keys: Uint8Array) => {
    const storageKey = buildStorageKey(address);
    await chrome.storage.local.set({[storageKey]: Buffer.from(keys).toString('binary')});
};

export const clearXmtpKeys = async (address: string) => {
    const storageKey = buildStorageKey(address);
    await chrome.storage.local.remove(storageKey);
};

export const getXmtpClient = async (): Promise<Client> => {
    if (client) return client;

    const signer = getSigner();
    if (!signer) throw new Error('Unable to get signer');

    const address = await signer?.getAddress();
    let keys = await loadKeys(address);
    if (!keys) {
        keys = await Client.getKeys(signer, {
            env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
        });
        await storeKeys(address, keys);
    }

    client = await Client.create(signer, {
        env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
        privateKeyOverride: keys,
    });
    return client;
};

export const canMessage = async (address: string): Promise<boolean> => Client.canMessage(address, {
    env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
});

const getUserProfileId = async () => {
    const storage = await chrome.storage.local.get('currentUser');
    return storage.currentUser?.profileId;
};

const fetchAllProfiles = async (profileIds: string[], userProfileId: string): Promise<Array<Profile>> => {
    const chunkSize = 50;
    let profiles: Profile[] = [];
    let cursor: any = null;
    let hasMore = true;

    while (hasMore) {
        const currentIds = profileIds.slice(0, chunkSize);
        profileIds = profileIds.slice(chunkSize);

        const { profiles: currentProfilesResult }: ProfilesQuery = await gqlClient.Profiles({
            request: { profileIds: currentIds, limit: chunkSize, cursor },
            userProfileId,
        });

        profiles = profiles.concat(currentProfilesResult.items);
        cursor = currentProfilesResult.pageInfo.next;
        hasMore = currentProfilesResult.pageInfo.next !== null && profileIds.length > 0;
    }

    return profiles;
};


const getProfiles = async (
    profileIds: string[],
): Promise<Profile[]> => {
    console.log('getProfiles: profileIds', profileIds);
    const userProfileId = await getUserProfileId();

    const profiles: Profile[] = [];
    let remainingIds = new Array(...profileIds);

    // First check if we have any profiles cached
    const storage = await chrome.storage.local.get(KEY_PROFILES);
    let savedProfiles = storage[KEY_PROFILES];
    if (savedProfiles) {
        for (const profileId of profileIds) {
            const savedProfile = savedProfiles[profileId];
            if (savedProfile) {
                profiles.push(savedProfile);
                remainingIds = remainingIds.filter((id) => id !== profileId);
            }
        }
    }

    if (remainingIds.length === 0) return profiles;

    const newProfiles = await fetchAllProfiles(remainingIds, userProfileId);
    console.log('getProfiles: new profiles to cache', newProfiles.length);

    if (!savedProfiles) {
        savedProfiles = {};
    }

    newProfiles.forEach((profile: Profile) => {
        savedProfiles[profile.id] = profile;
    });

    await chrome.storage.local.set({[KEY_PROFILES]: savedProfiles});
    console.log('getProfiles: saved profiles to cache', savedProfiles);

    return [...profiles, ...newProfiles];
};

export const isUnread = async (message: DecodedMessage, readTimestamps?: MessageTimestampMap): Promise<boolean> => {
    if (!message || !message.sent) return false;

    if (!readTimestamps) {
        readTimestamps = await getReadTimestamps() ?? {};
    }

    const timestamp = readTimestamps[message.contentTopic];

    if (!timestamp) {
        readTimestamps[message.contentTopic] = message.sent.getTime();
        await chrome.storage.local.set({[KEY_MESSAGE_TIMESTAMPS]: readTimestamps});
        return false;
    }

    return message.sent.getTime() > timestamp;
};

export const markAllAsRead = async (threads: Thread[]): Promise<Thread[]> => {
    const localStorage = await chrome.storage.local.get(KEY_MESSAGE_TIMESTAMPS);
    let readTimestamps = localStorage[KEY_MESSAGE_TIMESTAMPS];

    if (!readTimestamps) {
        readTimestamps = {};
    }

    threads.forEach((thread) => {
        if (thread.latestMessage && thread.latestMessage.sent) {
            readTimestamps[thread.latestMessage.contentTopic] = thread.latestMessage.sent.getTime();
        }
        thread.unread = false;
    });

    await chrome.storage.local.set({[KEY_MESSAGE_TIMESTAMPS]: readTimestamps});

    return threads;
};

const getReadTimestamps = async () => {
    const localStorage = await chrome.storage.local.get(KEY_MESSAGE_TIMESTAMPS);
    return localStorage[KEY_MESSAGE_TIMESTAMPS] as MessageTimestampMap;
};

const extractProfileId = (conversationId: string, userProfileId: string): string => {
    const idsWithoutPrefix = conversationId.substring(LENS_PREFIX.length + 1);
    const [profileIdA, profileIdB] = idsWithoutPrefix.split('-');
    return profileIdA === userProfileId ? profileIdB : profileIdA;
};

const getMessages = async (
    conversation: Conversation,
    limit: number = 1,
): Promise<DecodedMessage[]> => {
    return conversation.messages({
        direction: SortDirection.SORT_DIRECTION_DESCENDING,
        limit,
    });
};

export const isLensThread = (thread: Thread): boolean =>
    thread.conversation.context?.conversationId.startsWith(LENS_PREFIX) ?? false;

export const getLensThreads = (threads: Thread[], userProfileId: string): Thread[] => {
    return threads.filter((thread) =>
        isLensThread(thread) && thread.conversation.context?.conversationId.includes(userProfileId)
    );
};

export const getAllThreads = async (): Promise<Thread[]> => {
    const userProfileId = await getUserProfileId();
    const client = await getXmtpClient();

    const conversations: Conversation[] = await client.conversations.list();

    const lensConversations = conversations.filter((conversation) =>
        conversation.context?.conversationId?.startsWith(LENS_PREFIX)
    );
    const profileIds = lensConversations.map((conversation) =>
        extractProfileId(conversation.context!!.conversationId, userProfileId)
    );

    const profiles: Profile[] = await getProfiles(profileIds);
    const profilesMap: Map<string, Profile> = new Map(
        profiles.map((profile: Profile) => [profile.ownedBy, profile])
    );

    const readTimestamps = await getReadTimestamps() ?? {};

    const messagePromises = conversations.map(async (conversation) => {
        const messages = await getMessages(conversation);
        const latestMessage: DecodedMessage = messages[0];
        const unread = await isUnread(latestMessage, readTimestamps);
        return {latestMessage, unread};
    });

    const threads = await Promise.all(conversations.map(async (conversation, index) => {
        const {latestMessage, unread} = await messagePromises[index];
        const peerProfile = profilesMap.get(conversation.peerAddress);
        const peer: Peer = {
            profile: peerProfile,
            wallet: !peerProfile ? {
              address: conversation.peerAddress,
              ens: await getEnsFromAddress(conversation.peerAddress),
            } : undefined,
        }
        return {conversation, peer, latestMessage, unread} satisfies Thread;
    }));

    const sortByLatestMessage = (a: Thread, b: Thread): number => {
        if (!a.latestMessage || !a.latestMessage?.sent) return 1;
        if (!b.latestMessage || !b.latestMessage?.sent) return -1;
        return b.latestMessage.sent.getTime() - a.latestMessage.sent.getTime();
    };

    return threads.filter(thread => thread.latestMessage).sort(sortByLatestMessage);
};

const getPeerProfile = async (conversation: Conversation): Promise<Profile | undefined> => {
    const userProfileId = await getUserProfileId();
    const {profiles}: ProfilesQuery = await gqlClient.Profiles({
        request: {ownedBy: [conversation.peerAddress]}, userProfileId
    });
    return profiles.items?.[0];
};

export const getPeerName = (thread: Thread): string | null => {
    if (!thread?.peer) return null;

    const peerProfile = thread.peer.profile;
    if (!peerProfile) {
        return thread.peer.wallet?.ens ?? truncateAddress(thread.conversation.peerAddress)
    }

    return peerProfile.name ?? peerProfile.handle ?? truncateAddress(thread.conversation.peerAddress);
};

const buildPeer = async (conversation: Conversation) => {
    const profile: Profile | undefined = await getPeerProfile(conversation);
    const wallet = {
        address: conversation.peerAddress,
        ens: await getEnsFromAddress(conversation.peerAddress),
    };
    const peer: Peer = {profile, wallet};
    return peer;
};

export const getThreadStream = (): Observable<Thread> => new Observable((observer) => {
    let isObserverClosed = false;

    getXmtpClient().then((xmtp) => {
        xmtp.conversations.stream().then((stream) => {
            const onConversation = async () => {
                for await (const conversation of stream) {
                    if (isObserverClosed) {
                        await stream.return();
                        return;
                    }

                    const peerProfile = await getPeerProfile(conversation);
                    const messages = await getMessages(conversation);
                    const unread = messages[0] ? await isUnread(messages[0]) : false;
                    const peer: Peer = {
                        profile: peerProfile,
                        wallet: !peerProfile ? {
                            address: conversation.peerAddress,
                            ens: await getEnsFromAddress(conversation.peerAddress),
                        } : undefined,
                    }
                    observer.next({conversation, peer, unread} satisfies Thread);
                }
            };

            return onConversation();
        });

    });

    return () => {
        isObserverClosed = true;
    };
});

export const getThread = async (conversationId: string): Promise<Thread | undefined> => {
    const client = await getXmtpClient();

    const conversations: Conversation[] = await client.conversations.list();
    const conversation: Conversation | undefined = conversations.find(
        (conversation) => conversation.topic === conversationId
    );
    if (!conversation) return undefined;

    const peer: Peer = await buildPeer(conversation);
    return {conversation, peer} satisfies Thread;
};

export const findThread = async (peerAddress: string): Promise<Thread | undefined> => {
    if (!peerAddress) return undefined;

    const client = await getXmtpClient();

    const conversations: Conversation[] = await client.conversations.list();
    const conversation: Conversation | undefined = conversations.find(
        (conversation) => conversation.peerAddress === peerAddress
    );
    if (!conversation) return undefined;

    const peer = await buildPeer(conversation);
    return {conversation, peer} satisfies Thread;
};

const buildConversationId = (profileIdA: string, profileIdB: string) => {
    const profileIdAParsed = parseInt(profileIdA, 16)
    const profileIdBParsed = parseInt(profileIdB, 16)
    return profileIdAParsed < profileIdBParsed
        ? `${LENS_PREFIX}/${profileIdA}-${profileIdB}`
        : `${LENS_PREFIX}/${profileIdB}-${profileIdA}`
};

export const newThread = async (peer: Peer): Promise<Thread> => {
    const address = peer.wallet?.address || peer.profile?.ownedBy;
    if (!address) throw new Error('Cannot create thread without peer address');

    let context: InvitationContext | undefined;
    if (peer.profile) {
        context = {
            conversationId: buildConversationId(await getUserProfileId(), peer.profile.id),
            metadata: {},
        }
    }

    const client = await getXmtpClient();
    const conversation = await client.conversations.newConversation(address, context);

    return {conversation, peer, unread: false} satisfies Thread;
};

export const getMessagesStream = (conversation: Conversation): Observable<DecodedMessage> => new Observable((observer) => {
    let isObserverClosed = false;

    getXmtpClient().then((xmtp) => {
        conversation.streamMessages().then((stream: Stream<DecodedMessage>) => {
            const onMessage = async () => {
                for await (const message of stream) {
                    if (isObserverClosed) {
                        await stream.return();
                        return;
                    }

                    observer.next(message);
                }
            };

            return onMessage();
        });
    });

    // Cleanup when the Observable is unsubscribed
    return () => {
        isObserverClosed = true;
    };
});

export const getAllMessagesStream = (): Observable<DecodedMessage> => new Observable((observer) => {
    let isObserverClosed = false;

    getXmtpClient().then((xmtp) => {
        xmtp.conversations.streamAllMessages().then((stream: AsyncGenerator<DecodedMessage>) => {
            const onMessage = async () => {
                for await (const message of stream) {
                    if (isObserverClosed) {
                        break;
                    }

                    if (message.senderAddress === xmtp.address) continue;

                    observer.next(message);
                }
            };

            return onMessage();
        });
    });

    // Cleanup when the Observable is unsubscribed
    return () => {
        isObserverClosed = true;
    };
});