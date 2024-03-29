import {
    Client,
    type Conversation,
    DecodedMessage,
    SortDirection,
    Stream,
} from '@xmtp/xmtp-js';
import { Observable } from 'rxjs';
import {
    getCached,
    saveToCache,
    KEY_LATEST_MESSAGE_MAP,
    KEY_MESSAGE_TIMESTAMPS,
    KEY_PROFILES,
    KEY_PROFILE_ID_BY_ADDRESS,
    type LatestMessageMap,
    type MessageTimestampMap,
    type ProfileIdsByAddressMap,
    type ProfileMap,
} from './stores/cache-store';
import {
    buildXmtpStorageKey,
    getEnsFromAddress,
    getXmtpKeys,
    truncateAddress,
} from './utils/utils';
import type { InvitationContext } from '@xmtp/xmtp-js/dist/types/src/Invitation';
import { getUser } from './stores/user-store';
import type { User } from './user/user';
import { lookupAddresses } from './utils/lookup-addresses';
import { getAllProfiles, getProfiles } from './lens-service';
import type { ProfileFragment } from '@lens-protocol/client';
import { isMainnet } from '../config';

export const LENS_PREFIX = 'lens.dev/dm';

let client: Client;

export interface Peer {
    profile?: ProfileFragment;
    wallet?: {
        address: string;
        ens?: string | null;
    };
}

export interface CompactMessage {
    timestamp: number;
    contentTopic: string;
    content: string;
    senderAddress: string;
}

export interface Thread {
    conversation: Conversation;
    unread?: boolean;
    peer?: Peer;
    latestMessage?: CompactMessage;
}

export const isXmtpEnabled = async (): Promise<boolean> => {
    const user: User | undefined = await getUser();
    const address = user?.address;
    if (!address) return false;
    return (await getXmtpKeys(address)) !== null;
};

const storeKeys = async (address: string, keys: Uint8Array) => {
    const storageKey = buildXmtpStorageKey(address);
    await chrome.storage.local.set({
        [storageKey]: Buffer.from(keys).toString('binary'),
    });
};

const registerAttachmentCodecs = async () => {
    const { AttachmentCodec, RemoteAttachmentCodec } = await import(
        '@xmtp/content-type-remote-attachment'
    );
    client.registerCodec(new AttachmentCodec());
    client.registerCodec(new RemoteAttachmentCodec());
};

export const getXmtpClient = async (): Promise<Client> => {
    if (client) return client;

    let keys: Uint8Array | null = null;

    const user: User | undefined = await getUser();
    if (user?.address) {
        keys = await getXmtpKeys(user.address);
        if (keys) {
            client = await Client.create(null, {
                env: isMainnet ? 'production' : 'dev',
                privateKeyOverride: keys,
            });
            if (typeof window !== 'undefined') {
                await registerAttachmentCodecs();
            }
            return client;
        }
    }

    const { getSigner } = await import('./evm/ethers-service');
    const signer = await getSigner();
    if (!signer) throw new Error('Unable to find wallet for signing.');

    const address = await signer?.getAddress();
    keys = await Client.getKeys(signer, {
        env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
    });

    await storeKeys(address, keys);

    client = await Client.create(null, {
        env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
        privateKeyOverride: keys,
    });
    return client;
};

export const canMessage = async (address: string): Promise<boolean> =>
    Client.canMessage(address, {
        env: import.meta.env.MODE === 'development' ? 'dev' : 'production',
    });

const getUserProfileId = async (): Promise<string | undefined> => {
    const user = await getUser();
    return user?.profileId;
};

const getProfilesBatch = async (
    profileIds: string[]
): Promise<ProfileFragment[]> => {
    const profiles: ProfileFragment[] = [];
    const ids = profileIds.filter((id) => id !== 'undefined'); // ¯\_(ツ)_/¯
    let remainingIds = new Set(ids);

    // First check if we have any profiles cached
    let savedProfiles = (await getCached<ProfileMap>(KEY_PROFILES)) ?? {};
    if (savedProfiles) {
        for (const profileId of profileIds) {
            const savedProfile = savedProfiles[profileId];
            if (savedProfile) {
                profiles.push(savedProfile);
                const notFound = Array.from(remainingIds).filter(
                    (id) => id !== profileId
                );
                remainingIds = new Set(notFound);
            }
        }
    }

    if (remainingIds.size === 0) return profiles;

    const newProfiles = await getAllProfiles({
        profileIds: Array.from(remainingIds),
    });
    console.log('getProfiles: new profiles to cache', newProfiles.length);

    if (!savedProfiles) {
        savedProfiles = {};
    }

    newProfiles.forEach((profile: ProfileFragment) => {
        savedProfiles[profile.id] = profile;
    });

    await chrome.storage.local.set({ [KEY_PROFILES]: savedProfiles });
    console.log('getProfiles: saved profiles to cache', savedProfiles);

    return [...profiles, ...newProfiles];
};

export const isUnread = async (
    message: CompactMessage,
    readTimestamps?: MessageTimestampMap
): Promise<boolean> => {
    if (!message) return false;

    const user = await getUser();
    if (!user || message.senderAddress === user.address) return false;

    if (!readTimestamps) {
        readTimestamps = (await getReadTimestamps()) ?? {};
    }

    const timestamp = readTimestamps[message.contentTopic] ?? 0;
    return message.timestamp > timestamp;
};

export const markAllAsRead = async (threads: Thread[]): Promise<Thread[]> => {
    const localStorage = await chrome.storage.local.get(KEY_MESSAGE_TIMESTAMPS);
    let readTimestamps = localStorage[KEY_MESSAGE_TIMESTAMPS];

    if (!readTimestamps) {
        readTimestamps = {};
    }

    threads.forEach((thread) => {
        if (thread.latestMessage && thread.latestMessage.timestamp) {
            readTimestamps[thread.latestMessage.contentTopic] =
                thread.latestMessage.timestamp;
        }
        thread.unread = false;
    });

    await chrome.storage.local.set({
        [KEY_MESSAGE_TIMESTAMPS]: readTimestamps,
    });

    return threads;
};

export const getReadTimestamps = async (): Promise<MessageTimestampMap> => {
    const localStorage = await chrome.storage.local.get(KEY_MESSAGE_TIMESTAMPS);
    return localStorage[KEY_MESSAGE_TIMESTAMPS] as MessageTimestampMap;
};

const getProfilesFromConversationId = (
    conversationId: string
): { profileIdB: string; profileIdA: string } => {
    const idsWithoutPrefix = conversationId.substring(LENS_PREFIX.length + 1);
    const [profileIdA, profileIdB] = idsWithoutPrefix.split('-');
    return { profileIdA, profileIdB };
};

const extractProfileId = (
    conversationId: string,
    userProfileIds?: string[]
): string => {
    if (!userProfileIds || userProfileIds.length === 0)
        throw new Error('User profile id is required');
    const { profileIdA, profileIdB } =
        getProfilesFromConversationId(conversationId);
    const userProfileId = userProfileIds.find(
        (id) => id === profileIdA || id === profileIdB
    );
    return profileIdA === userProfileId ? profileIdB : profileIdA;
};

let lastMessagesRequestTime: number | undefined;
const messagesRequestThrottleMs = 100;

const getMessages = async (
    conversation: Conversation,
    limit: number = 1,
    startTime?: Date
): Promise<DecodedMessage[]> => {
    const now = Date.now();
    const timeSinceLastRequest =
        now - (lastMessagesRequestTime ?? now - messagesRequestThrottleMs);

    if (timeSinceLastRequest < messagesRequestThrottleMs) {
        await new Promise((resolve) =>
            setTimeout(
                resolve,
                messagesRequestThrottleMs - timeSinceLastRequest
            )
        );
    }

    lastMessagesRequestTime = Date.now();

    return conversation.messages({
        direction: SortDirection.SORT_DIRECTION_DESCENDING,
        limit,
        startTime,
    });
};

const cacheLatestMessages = async (
    conversationMessages: Map<Conversation, DecodedMessage[]>
): Promise<LatestMessageMap> => {
    const latestMessages: LatestMessageMap =
        (await getCached(KEY_LATEST_MESSAGE_MAP)) ?? {};
    for (const [conversation, messages] of conversationMessages) {
        if (messages.length > 0) {
            latestMessages[conversation.topic] = toCompactMessage(messages[0]);
        }
    }

    await saveToCache(KEY_LATEST_MESSAGE_MAP, latestMessages);
    console.log('updateLatestMessageCache: saved latest messages to cache');

    return latestMessages;
};

export const updateLatestMessageCache = async (): Promise<LatestMessageMap> => {
    const user = await getUser();
    if (!user) throw new Error('User is not logged in');

    const xmtpClient = await getXmtpClient();

    const conversationMessages: Map<Conversation, DecodedMessage[]> =
        await getMessagesBatch(xmtpClient, user.address, 1, false, false);
    return cacheLatestMessages(conversationMessages);
};

export const isLensConversation = (conversation: Conversation): boolean =>
    conversation.context?.conversationId?.startsWith(LENS_PREFIX) ?? false;

export const isLensThread = (thread: Thread): boolean =>
    isLensConversation(thread.conversation);

export const isProfileConversation = (
    conversation: Conversation,
    userProfileId: string
): boolean => {
    const conversationId = conversation.context?.conversationId;
    return conversationId?.includes(userProfileId) ?? false;
};

export const isProfileThread = (
    thread: Thread,
    userProfileId: string
): boolean => isProfileConversation(thread.conversation, userProfileId);

export const getMessagesBatch = async (
    xmtpClient: Client,
    address: string,
    pageSize: number,
    unreadOnly: boolean = false,
    peerOnly: boolean = false,
    isFirstRun: boolean = false,
    conversations?: Conversation[]
): Promise<Map<Conversation, DecodedMessage[]>> => {
    const readTimestamps = (await getReadTimestamps()) ?? {};

    if (!conversations) {
        conversations = await xmtpClient.conversations.list();
    }

    const getReadTimestamp = async (
        conversation: Conversation
    ): Promise<Date | undefined> => {
        if (!readTimestamps[conversation.topic] && isFirstRun) {
            readTimestamps[conversation.topic] = new Date().getTime();
            await chrome.storage.local.set({
                [KEY_MESSAGE_TIMESTAMPS]: readTimestamps,
            });
        }

        return new Date(readTimestamps[conversation.topic]);
    };

    const queryPromises = conversations.map(async (conversation) => ({
        contentTopic: conversation.topic,
        startTime: unreadOnly
            ? await getReadTimestamp(conversation)
            : undefined,
        direction: SortDirection.SORT_DIRECTION_DESCENDING,
        pageSize,
    }));
    const queries = await Promise.all(queryPromises);
    const queryResults = await xmtpClient.apiClient.batchQuery(queries);

    const conversationMap: Map<Conversation, DecodedMessage[]> = new Map();

    for (let i = 0; i < queryResults.length; i++) {
        const queryResult = queryResults[i];
        if (queryResult.length === 0) continue;
        const conversation = conversations[i];

        const messagesPromises: Promise<DecodedMessage>[] = queryResult
            .filter((envelope) => envelope.message)
            .map((envelope) => conversation.decodeMessage(envelope));
        const messages: DecodedMessage[] = await Promise.all(messagesPromises);

        if (peerOnly) {
            const peerMessages = messages.filter(
                (message) => message.senderAddress !== address
            );
            if (peerMessages.length > 0) {
                conversationMap.set(conversation, peerMessages);
            }
            continue;
        }

        conversationMap.set(conversation, messages);
    }

    return conversationMap;
};

export const getUnreadThreads = async (
    xmtpClient: Client,
    isFirstRun: boolean = false
): Promise<Map<Thread, DecodedMessage[]>> => {
    const user = await getUser();
    if (!user) throw new Error('User is not logged in');

    const conversationMessages: Map<Conversation, DecodedMessage[]> =
        await getMessagesBatch(
            xmtpClient,
            user.address,
            10,
            true,
            true,
            isFirstRun
        );

    await cacheLatestMessages(conversationMessages);

    const unreadConversations = [...conversationMessages.keys()];
    const lensConversations = unreadConversations.filter(
        (conversation) =>
            conversation.context?.conversationId?.startsWith(LENS_PREFIX)
    );

    const profilesOwnedByAddress = await getProfiles({
        ownedBy: [user.address],
    });
    const userProfileIds = profilesOwnedByAddress.items.map(
        (profile: ProfileFragment) => profile.id
    );
    const profileIds = lensConversations.map((conversation) =>
        extractProfileId(conversation.context!!.conversationId, userProfileIds)
    );

    const profiles: ProfileFragment[] = await getProfilesBatch(profileIds);
    const profilesMap: Map<string, ProfileFragment> = new Map(
        profiles.map((profile: ProfileFragment) => [
            profile.ownedBy.address,
            profile,
        ])
    );

    const peerAddresses = unreadConversations.map(
        (conversation) => conversation.peerAddress
    );
    const ensNames = await lookupAddresses(peerAddresses);

    const result: Map<Thread, DecodedMessage[]> = new Map();
    for (const conversation of unreadConversations) {
        const messages =
            conversationMessages
                .get(conversation)
                ?.filter((c) => c.senderAddress !== '') ?? [];
        const profile = profilesMap.get(conversation.peerAddress);
        const peer: Peer = {
            profile,
            wallet: !profile
                ? {
                      address: conversation.peerAddress,
                      ens: ensNames.get(conversation.peerAddress),
                  }
                : undefined,
        };
        const thread: Thread = {
            conversation,
            peer,
        };
        result.set(thread, messages);
    }

    return result;
};

export const getUserAddress = async (): Promise<string> => {
    const user = await getUser();
    if (!user) throw new Error('User is not logged in');
    return user.address;
};

const sortByLatestMessage = (a: Thread, b: Thread): number => {
    if (!a.latestMessage) return 1;
    if (!b.latestMessage) return -1;
    return b.latestMessage.timestamp - a.latestMessage.timestamp;
};

export const getAllThreads = async (): Promise<Thread[]> => {
    const userAddress = await getUserAddress();
    const xmtpClient = await getXmtpClient();

    const conversations: Conversation[] = await xmtpClient.conversations.list();

    const lensConversations = [];
    const otherConversations = [];

    for (const conversation of conversations) {
        if (conversation.context?.conversationId?.startsWith(LENS_PREFIX)) {
            lensConversations.push(conversation);
        } else {
            otherConversations.push(conversation);
        }
    }

    const profiles: Set<ProfileFragment> = new Set();

    if (lensConversations.length) {
        // One address can hold multiple Lens profiles, so we need to fetch all profiles owned by the user
        const profilesOwnedByUser = await getProfiles({
            ownedBy: [userAddress],
        });
        const userProfileIds = profilesOwnedByUser.items.map(
            (profile) => profile.id
        );
        const profileIds = lensConversations.map((conversation) =>
            extractProfileId(
                conversation.context!!.conversationId,
                userProfileIds
            )
        );
        // Getting profiles by id is faster than getting them by address
        const lensProfiles: ProfileFragment[] =
            await getProfilesBatch(profileIds);
        lensProfiles.forEach((profile) => profiles.add(profile));
    }

    let ensNames: Map<string, string | null> = new Map();

    if (otherConversations.length) {
        let otherConversationAddresses = otherConversations.map(
            (conversation) => conversation.peerAddress
        );

        ensNames = await lookupAddresses(otherConversationAddresses);

        const cachedProfileIdsMap =
            (await getCached<ProfileIdsByAddressMap>(
                KEY_PROFILE_ID_BY_ADDRESS
            )) ?? {};

        const savedProfiles = (await getCached<ProfileMap>(KEY_PROFILES)) ?? {};

        const cachedProfileIds = otherConversationAddresses
            .filter((address) => cachedProfileIdsMap[address])
            .map((address) => cachedProfileIdsMap[address])
            .flatMap((ids) => ids);

        for (const profileId of cachedProfileIds) {
            const savedProfile = savedProfiles[profileId];
            if (savedProfile) {
                profiles.add(savedProfile);
                otherConversationAddresses = otherConversationAddresses.filter(
                    (address) => address !== savedProfile.ownedBy.address
                );
            }
        }

        const nonLensConversationProfiles = await getAllProfiles({
            ownedBy: otherConversationAddresses,
        });
        if (nonLensConversationProfiles.length) {
            nonLensConversationProfiles.forEach((profile) => {
                profiles.add(profile);
                savedProfiles[profile.id] = profile;
                const address = profile.ownedBy.address;
                if (cachedProfileIdsMap[address]) {
                    cachedProfileIdsMap[address].push(profile.id);
                } else {
                    cachedProfileIdsMap[address] = [profile.id];
                }
            });

            await saveToCache(KEY_PROFILES, savedProfiles);
            await saveToCache(KEY_PROFILE_ID_BY_ADDRESS, cachedProfileIdsMap);
        }
    }

    const profilesMap: Map<string, ProfileFragment> = new Map(
        Array.from(profiles).map((profile: ProfileFragment) => [
            profile.ownedBy.address,
            profile,
        ])
    );

    let latestMessageMap: LatestMessageMap | undefined = await getCached(
        KEY_LATEST_MESSAGE_MAP
    );

    if (!latestMessageMap || Object.keys(latestMessageMap).length === 0) {
        const conversationMessages: Map<Conversation, DecodedMessage[]> =
            await getMessagesBatch(
                xmtpClient,
                userAddress,
                1,
                false,
                false,
                false,
                conversations
            );
        latestMessageMap = await cacheLatestMessages(conversationMessages);
    }
    console.timeLog('getAllThreads', 'got latest messages');

    const readTimestamps = (await getReadTimestamps()) ?? {};

    const threads: Thread[] = [];
    for (const conversation of conversations) {
        const latestMessage: CompactMessage | undefined =
            latestMessageMap?.[conversation.topic];
        const unread = latestMessage
            ? await isUnread(latestMessage, readTimestamps)
            : false;
        const peerProfile = profilesMap.get(conversation.peerAddress);
        const peer: Peer = {
            profile: peerProfile,
            wallet: {
                address: conversation.peerAddress,
                ens: ensNames.get(conversation.peerAddress),
            },
        };
        const thread: Thread = { conversation, peer, latestMessage, unread };
        threads.push(thread);
    }
    console.timeLog('getAllThreads', 'built threads');

    console.timeEnd('getAllThreads');

    return threads
        .filter((thread) => thread.latestMessage)
        .sort(sortByLatestMessage);
};

const getPeerProfile = async (
    conversation: Conversation
): Promise<ProfileFragment | undefined> => {
    console.log(
        'getPeerProfile: conversation',
        conversation.topic,
        conversation.context?.conversationId
    );
    const profilesRes = await getProfiles({
        ownedBy: [conversation.peerAddress],
    });
    console.log('getPeerProfile: profilesRes', profilesRes);

    const userProfileId = await getUserProfileId();
    if (userProfileId && isProfileConversation(conversation, userProfileId)) {
        const { profileIdA, profileIdB } = getProfilesFromConversationId(
            conversation.context!.conversationId
        );
        console.log(
            'getPeerProfile: profileIdA',
            profileIdA,
            'profileIdB',
            profileIdB
        );
        return profilesRes.items.find(
            (profile) => profile.id === profileIdA || profile.id === profileIdB
        );
    }

    return profilesRes.items?.[0];
};

export const getPeerName = (
    thread: Thread,
    ens?: string | null
): string | undefined => {
    if (!thread?.peer) return undefined;

    const peer = thread.peer;
    const peerProfile = peer.profile;

    // Fallback to Lens Profile name if not a Lens conversation and there's no ENS
    if ((isLensThread(thread) && peerProfile) || (peerProfile && !ens)) {
        return (
            peerProfile.metadata?.displayName ??
            peerProfile.handle?.localName ??
            truncateAddress(peerProfile.ownedBy.address)
        );
    }

    return (
        ens ??
        peer.wallet?.ens ??
        (peer.wallet?.address && truncateAddress(peer.wallet.address))
    );
};

const buildPeer = async (conversation: Conversation) => {
    const profile: ProfileFragment | undefined =
        await getPeerProfile(conversation);
    const wallet = {
        address: conversation.peerAddress,
        ens: await getEnsFromAddress(conversation.peerAddress),
    };
    const peer: Peer = { profile, wallet };
    return peer;
};

export const getThreadStream = (): Observable<Thread> =>
    new Observable((observer) => {
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
                        const messages = await getMessages(conversation, 1);
                        const unread = messages[0]
                            ? await isUnread(toCompactMessage(messages[0]))
                            : false;
                        const peer: Peer = {
                            profile: peerProfile,
                            wallet: !peerProfile
                                ? {
                                      address: conversation.peerAddress,
                                      ens: await getEnsFromAddress(
                                          conversation.peerAddress
                                      ),
                                  }
                                : undefined,
                        };
                        observer.next({
                            conversation,
                            peer,
                            unread,
                        } satisfies Thread);
                    }
                };

                return onConversation();
            });
        });

        return () => {
            isObserverClosed = true;
        };
    });

export const getConversation = async (
    conversationId: string,
    xmtpClient?: Client
): Promise<Conversation | undefined> => {
    if (!xmtpClient) {
        xmtpClient = await getXmtpClient();
    }

    const conversations: Conversation[] = await xmtpClient.conversations.list();
    return conversations.find(
        (conversation) => conversation.topic === conversationId
    );
};

export const getThread = async (
    conversationId: string,
    xmtpClient?: Client
): Promise<Thread> => {
    const conversation: Conversation | undefined = await getConversation(
        conversationId,
        xmtpClient
    );
    if (!conversation)
        throw new Error(`Conversation ${conversationId} not found`);

    const peer: Peer = await buildPeer(conversation);
    return { conversation, peer } satisfies Thread;
};

export const findThread = async (
    peerAddress: string
): Promise<Thread | undefined> => {
    if (!peerAddress) return undefined;

    const xmtpClient = await getXmtpClient();

    const conversations: Conversation[] = await xmtpClient.conversations.list();
    const conversation: Conversation | undefined = conversations.find(
        (c) => c.peerAddress === peerAddress
    );
    if (!conversation) return undefined;

    const peer = await buildPeer(conversation);
    return { conversation, peer } satisfies Thread;
};

const buildConversationId = (profileIdA: string, profileIdB: string) => {
    const profileIdAParsed = parseInt(profileIdA, 16);
    const profileIdBParsed = parseInt(profileIdB, 16);
    return profileIdAParsed < profileIdBParsed
        ? `${LENS_PREFIX}/${profileIdA}-${profileIdB}`
        : `${LENS_PREFIX}/${profileIdB}-${profileIdA}`;
};

export const newThread = async (peer: Peer): Promise<Thread> => {
    const address = peer.wallet?.address || peer.profile?.ownedBy.address;
    if (!address) throw new Error('Cannot create thread without peer address');

    const userProfileId = await getUserProfileId();
    if (!userProfileId)
        throw new Error('Cannot create thread without user profile id');

    let context: InvitationContext | undefined;
    if (peer.profile) {
        context = {
            conversationId: buildConversationId(userProfileId, peer.profile.id),
            metadata: {},
        };
    }

    const xmtpClient = await getXmtpClient();
    const conversation = await xmtpClient.conversations.newConversation(
        address,
        context
    );

    return { conversation, peer, unread: false } satisfies Thread;
};

export const getMessagesStream = (
    conversation: Conversation
): Observable<DecodedMessage> =>
    new Observable((observer) => {
        let isObserverClosed = false;

        getXmtpClient().then(() => {
            conversation
                .streamMessages()
                .then((stream: Stream<DecodedMessage>) => {
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

export const getAllMessagesStream = (): Observable<DecodedMessage> =>
    new Observable((observer) => {
        let isObserverClosed = false;

        getXmtpClient().then((xmtp) => {
            xmtp.conversations
                .streamAllMessages()
                .then((stream: AsyncGenerator<DecodedMessage>) => {
                    const onMessage = async () => {
                        const user = await getUser();

                        for await (const message of stream) {
                            if (isObserverClosed) {
                                break;
                            }

                            if (message.senderAddress === xmtp.address)
                                continue;

                            if (isLensConversation(message.conversation)) {
                                const conversationId =
                                    message.conversation.context!
                                        .conversationId;
                                const { profileIdA, profileIdB } =
                                    getProfilesFromConversationId(
                                        conversationId
                                    );
                                if (
                                    profileIdA !== user?.profileId &&
                                    profileIdB !== user?.profileId
                                )
                                    continue;
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

export const toCompactMessage = (
    decodedMessage: DecodedMessage
): CompactMessage => {
    const { sent, contentTopic, content, senderAddress } = decodedMessage;
    return { timestamp: sent.getTime(), contentTopic, content, senderAddress };
};
