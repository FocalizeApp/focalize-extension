import {v4 as uuid} from "uuid";
import Autolinker, {UrlMatch} from "autolinker";

import {APP_ID} from "../config";
import {DEFAULT_REFERENCE_MODULE, REVERT_COLLECT_MODULE} from "./lens-modules";

import {PublicationContentWarning, PublicationMainFocus, PublicationMetadataDisplayTypes} from "../graph/lens-service";
import {getOrRefreshAccessToken} from "./lens-auth";
import {uploadAndPin} from "./ipfs-service";
import {getLensHub} from "../lens-hub";
import {signTypedData} from "./ethers-service";

import gqlClient from "../graph/graphql-client";

import type {
    BroadcastRequest,
    CollectModuleParams, CreatePostBroadcastItemResult,
    CreatePublicPostRequest,
    MetadataAttributeInput,
    PublicationMetadataMediaInput,
    PublicationMetadataV2Input,
    ReferenceModuleParams,
    RelayerResult,
    ValidatePublicationMetadataRequest
} from "../graph/lens-service";
import type {User} from "./user";

const makeMetadataFile = (metadata: PublicationMetadataV2Input): File => {
    const obj = {
        ...metadata,
        version: '2.0.0',
        metadata_id: uuid(),
        appId: APP_ID,
        locale: 'en',
    }
    let o = Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
    console.log('makeMetadataFile: Creating metadata file for', o);
    const blob = new Blob([JSON.stringify(o)], {type: 'application/json'})
    return new File([blob], `metadata.json`)
};

export const generateTextPostMetadata = (
    handle: string,
    content: string,
    mainContentFocus: PublicationMainFocus,
    tags?: string[],
    contentWarning?: PublicationContentWarning,
    attributes: MetadataAttributeInput[] = [],
): PublicationMetadataV2Input => (
    {
        name: `Post by @${handle}`,
        content,
        mainContentFocus,
        tags,
        contentWarning,
        attributes
    } as PublicationMetadataV2Input
)

export const generateImagePostMetadata = (
    handle: string,
    media: PublicationMetadataMediaInput,
    title?: string,
    content?: string,
    tags?: string[],
    contentWarning?: PublicationContentWarning,
    description: string | undefined = content,
    image: string = media.item,
    imageMimeType: string = media.type,
    attributes: MetadataAttributeInput[] = [],
): PublicationMetadataV2Input => (
    {
        name: title || `Post by @${handle}`,
        media: [media],
        image,
        imageMimeType,
        content,
        description,
        mainContentFocus: PublicationMainFocus.Image,
        tags,
        contentWarning,
        attributes,
        external_url: import.meta.env.VITE_LENS_PREVIEW_NODE + 'u/'+ handle,
    } as PublicationMetadataV2Input
)

export const createVideoAttributes = (): MetadataAttributeInput[] => {
    return [
        {
            displayType: PublicationMetadataDisplayTypes.String,
            traitType: 'type',
            value: 'video'
        }
    ] as MetadataAttributeInput[];
}

export const generateVideoPostMetadata = (
    handle: string,
    media: PublicationMetadataMediaInput,
    title?: string,
    image?: string,
    imageMimeType?: string,
    content?: string,
    attributes?: MetadataAttributeInput[],
    tags?: string[],
    contentWarning?: PublicationContentWarning,
    description: string | undefined = content,
    animationUrl: string = media.item,
): PublicationMetadataV2Input => (
    {
        name: title || `Post by @${handle}`,
        media: [media],
        image,
        imageMimeType,
        animation_url: animationUrl,
        content,
        description,
        attributes,
        mainContentFocus: PublicationMainFocus.Video,
        tags,
        contentWarning,
        external_url: import.meta.env.VITE_LENS_PREVIEW_NODE + 'u/'+ handle,
    } as PublicationMetadataV2Input
);

export const createAudioAttributes = (author: string): MetadataAttributeInput[] => {
    return [
        {
            displayType: PublicationMetadataDisplayTypes.String,
            traitType: 'author',
            value: author
        },
        {
            displayType: PublicationMetadataDisplayTypes.String,
            traitType: 'type',
            value: 'audio'
        }
    ] as MetadataAttributeInput[];
}

export const generateAudioPostMetadata = (
    handle: string,
    media: PublicationMetadataMediaInput,
    title?: string,
    image?: string,
    imageMimeType?: string,
    content?: string,
    attributes?: MetadataAttributeInput[],
    tags?: string[],
    contentWarning?: PublicationContentWarning,
    description: string | undefined = content,
    animationUrl: string = media.item,
): PublicationMetadataV2Input => {
    const artistAttr = attributes?.find(attr => attr.traitType === 'author');
    return {
        name: artistAttr ? `${artistAttr.value} - ${title}` : title,
        media: [media],
        image,
        imageMimeType,
        animation_url: animationUrl,
        content,
        description,
        attributes,
        mainContentFocus: PublicationMainFocus.Audio,
        tags,
        contentWarning,
        external_url: import.meta.env.VITE_LENS_PREVIEW_NODE + 'u/' + handle,
    } as PublicationMetadataV2Input;
};

const validateMetadata = async (metadata: PublicationMetadataV2Input) => {
    const request: ValidatePublicationMetadataRequest = {
        metadatav2: {
            ...metadata,
            version: '2.0.0',
            metadata_id: uuid(),
            appId: APP_ID,
        }
    };
    const {validatePublicationMetadata} = await gqlClient.ValidatePublicationMetadata({request});
    return validatePublicationMetadata;
}

const createPostViaDispatcher = async (request: CreatePublicPostRequest): Promise<RelayerResult> => {
    const {createPostViaDispatcher} = await gqlClient.CreatePostViaDispatcher({request});
    if (createPostViaDispatcher.__typename === 'RelayError') throw createPostViaDispatcher.reason;
    return createPostViaDispatcher as RelayerResult;
}

const createPostTypedData = async (
    profileId: string,
    contentURI: string,
    collectModule: CollectModuleParams,
    referenceModule: ReferenceModuleParams,
): Promise<CreatePostBroadcastItemResult> => {
    const request = {profileId, contentURI, referenceModule, collectModule}
    const {createPostTypedData} = await gqlClient.CreatePostTypedData({request});
    return createPostTypedData;
};

const createPostTransaction = async (
    profileId: string,
    contentURI: string,
    accessToken: string,
    useRelay: boolean,
    collectModule: CollectModuleParams = REVERT_COLLECT_MODULE,
    referenceModule: ReferenceModuleParams = DEFAULT_REFERENCE_MODULE,
): Promise<string> => {
    const postResult = await createPostTypedData(
        profileId,
        contentURI,
        collectModule,
        referenceModule
    );

    const typedData = postResult.typedData;
    console.log('createPostTransaction: Created post typed data', typedData);

    if (useRelay) {
        // @ts-ignore This function strips the __typename
        const signature = await signTypedData(typedData.domain, typedData.types, typedData.value);
        const request: BroadcastRequest = {
            id: postResult.id,
            signature
        }
        const {broadcast} = await gqlClient.Broadcast({request});

        if (broadcast.__typename === 'RelayerResult') {
            console.log('createPostTransaction: broadcast transaction success', broadcast.txHash)
            return broadcast.txHash;
        } else if (broadcast.__typename === 'RelayError') {
            console.error('createPostTransaction: post with broadcast failed', broadcast.reason);
            // allow fallback to self-broadcasting
        }
    }

    const lensHub = getLensHub();
    const tx = await lensHub.post({
        profileId: typedData.value.profileId,
        contentURI: typedData.value.contentURI,
        collectModule: typedData.value.collectModule,
        collectModuleInitData: typedData.value.collectModuleInitData,
        referenceModule: typedData.value.referenceModule,
        referenceModuleInitData: typedData.value.referenceModuleInitData
    });
    console.log('createPostTransaction: submitted transaction', tx);
    return tx.hash;
};

export const submitPost = async (
    user: User,
    metadata: PublicationMetadataV2Input,
    referenceModule: ReferenceModuleParams = DEFAULT_REFERENCE_MODULE,
    collectModule: CollectModuleParams = REVERT_COLLECT_MODULE,
    useDispatcher: boolean = true,
    useRelay: boolean = false
): Promise<string> => {
    const profileId = user.profileId;
    console.log(`submitPost: profileId = ${profileId}, metadata = ${JSON.stringify(metadata)}, referenceModule = ${JSON.stringify(referenceModule)}, collectModule = ${JSON.stringify(collectModule)}`)
    const accessToken = await getOrRefreshAccessToken();

    const validate = await validateMetadata(metadata);
    if (!validate.valid) {
        throw validate.reason;
    }

    const metadataFile: File = makeMetadataFile(metadata);
    const metadataCid = await uploadAndPin(metadataFile);
    const contentURI = `ipfs://${metadataCid}`;
    console.log('submitPost: Uploaded metadata to IPFS with URI', contentURI);

    let txHash: string | undefined;

    if (useDispatcher && user.canUseRelay) {
        try {
            const relayerResult = await createPostViaDispatcher(
                {profileId, contentURI, collectModule, referenceModule}
            );
            txHash = relayerResult.txHash;
            console.log('submitPost: created post with dispatcher', txHash);
        } catch (e) {
            console.error('Error creating post with dispatcher', e);
        }
    }

    if (!txHash) {
        txHash = await createPostTransaction(profileId, contentURI, accessToken, useRelay, collectModule, referenceModule);
    }

    const res = await chrome.runtime.sendMessage({getPublicationId: {txHash, metadata}});
    if (res.error) throw res.error;

    console.log('submitPost: post has been indexed', res.publicationId);

    return res.publicationId;
};

export const getUrlsFromText = (content: string): string[] => {
    const matches = Autolinker.parse(content, {
        phone: false,
        email: false,
        stripPrefix: false,
        urls: {
            tldMatches: true
        }
    });
    console.log('autolink: matches =', matches);

    if (matches.length === 0) {
        return [];
    }

    const urlMatches = matches.filter((match): match is UrlMatch => match instanceof UrlMatch);
    return urlMatches.map(match => {
        if (match.getUrlMatchType() === "tld") {
            return 'https://' + match.getUrl();
        }
        return match.getUrl();
    });
}