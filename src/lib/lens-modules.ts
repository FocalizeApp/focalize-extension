import type {
    CollectModuleParams, EnabledModuleCurrenciesQuery, Erc20, FeeCollectModuleSettings, LimitedFeeCollectModuleSettings,
    LimitedTimedFeeCollectModuleSettings, ReferenceModuleParams, TimedFeeCollectModuleSettings,
} from "../graph/lens-service";

import {
    AsyncEnabledModuleCurrencies,
    CollectModules, PublicationContentWarning,
} from "../graph/lens-service";

import type {ApolloQueryResult} from "@apollo/client";

export type ContentWarning = string | PublicationContentWarning.Nsfw | PublicationContentWarning.Spoiler | PublicationContentWarning.Sensitive | null;

export type PaidCollectModule = FeeCollectModuleSettings | LimitedFeeCollectModuleSettings | LimitedTimedFeeCollectModuleSettings | TimedFeeCollectModuleSettings;

export type SelectItem<Type> = {
    value: Type,
    label: string,
    summary?: string,
    icon?: string
};

export const REFERENCE_ITEMS: SelectItem<ReferenceModuleParams>[] = [
    {
        value: {
            followerOnlyReferenceModule: false
        },
        label: 'Everyone can engage',
        summary: 'Anyone can reply and repost',
        icon: 'earth'
    },
    {
        value: {
            followerOnlyReferenceModule: true
        },
        label: 'Followers only',
        summary: 'Only your followers can reply and repost',
        icon: 'followers'
    },
    {
        value: {
            degreesOfSeparationReferenceModule: {
            "commentsRestricted": true,
            "mirrorsRestricted": false,
            "degreesOfSeparation": 0
            }
        },
        label: 'No comments',
        summary: 'No one can comment, including you. Anyone can\nrepost',
        icon: 'lock'
    },
    {
        value: {
            degreesOfSeparationReferenceModule: {
                "commentsRestricted": true,
                "mirrorsRestricted": true,
                "degreesOfSeparation": 1
            }
        },
        label: 'Friends only',
        summary: 'Only profiles that you follow can reply and repost',
        icon: 'friends'
    },
    {
        value: {
            degreesOfSeparationReferenceModule: {
                "commentsRestricted": true,
                "mirrorsRestricted": true,
                "degreesOfSeparation": 2
            }
        },
        label: 'Friends of friends',
        summary: 'Only profiles that you follow, and the profiles they\nfollow, can reply and repost',
        icon: 'friends_of_friends'
    },
];

export type CollectModuleItem = {
    type: CollectModules,
    followerOnly?: boolean
}

export const FEE_COLLECT_ITEM: SelectItem<CollectModuleItem> = {
    value: {
        type: CollectModules.FeeCollectModule
    },
    label: 'Sell NFT',
    summary: 'Charge for NFT collection',
    icon: 'collect_paid'
}

export const COLLECT_ITEMS: SelectItem<CollectModuleItem>[] = [
    {
        value: {
            type: CollectModules.RevertCollectModule
        },
        label: 'Disable NFT Collection',
        summary: 'Do not allow the post to be collected as an NFT',
        icon: 'collect_disabled'
    },
    {
        value: {
            type: CollectModules.FreeCollectModule,
            followerOnly: false,
        },
        label: 'Free to collect',
        summary: 'Post can be collected as an NFT for free',
        icon: 'collect_free'
    },
    {
        value: {
            type: CollectModules.FreeCollectModule,
            followerOnly: true,
        },
        label: 'Free for followers',
        summary: 'Followers can collect the post as an NFT for free',
        icon: 'followers'
    },
    FEE_COLLECT_ITEM,
];

export const CONTENT_WARNING_ITEMS: SelectItem<ContentWarning>[] = [
    {value: null, label: 'No content warning'},
    {value: PublicationContentWarning.Nsfw, label: 'NSFW'},
    {value: PublicationContentWarning.Spoiler, label: 'Spoiler'},
    {value: PublicationContentWarning.Sensitive, label: 'Sensitive'},
];

export const REVERT_COLLECT_MODULE: CollectModuleParams = {revertCollectModule: true};

export const DEFAULT_REFERENCE_MODULE: ReferenceModuleParams = {followerOnlyReferenceModule: false}

export const getEnabledModuleCurrencies = async (): Promise<Erc20[]> => {
    const res: ApolloQueryResult<EnabledModuleCurrenciesQuery> = await AsyncEnabledModuleCurrencies({})
    if (res.error) {
        return Promise.reject(res.error);
    }
    return Promise.resolve(res.data.enabledModuleCurrencies);
};

const getPaidCollectModuleParams = (module: PaidCollectModule): CollectModuleParams => {
    if (!module) {
        return {};
    }

    const baseModule =  {
        amount: {
            currency: module.amount.asset.address,
            value: module.amount.value
        },
        followerOnly: module.followerOnly ?? false,
        recipient: module.recipient,
        referralFee: module.referralFee
    }

    switch (module.__typename) {
        case 'LimitedTimedFeeCollectModuleSettings':
            return {
                limitedTimedFeeCollectModule: {
                    ...baseModule,
                    collectLimit: module.collectLimit.toString()
                }
            }
        case 'LimitedFeeCollectModuleSettings':
            return {
                limitedFeeCollectModule: {
                    ...baseModule,
                    collectLimit: module.collectLimit.toString()
                }
            }
        case 'TimedFeeCollectModuleSettings':
            return {
                timedFeeCollectModule: {
                    ...baseModule
                }
            }
    }

    return {
        feeCollectModule: {
            ...baseModule
        }
    }
};

export const getCollectModuleParams = (
    item: SelectItem<CollectModuleItem>,
    feeCollectModule: PaidCollectModule
): CollectModuleParams | undefined => {
    switch (item.value.type) {
        case CollectModules.FreeCollectModule:
            return {freeCollectModule: {followerOnly: item.value.followerOnly ?? false}};
        case CollectModules.RevertCollectModule:
            return REVERT_COLLECT_MODULE;
        case CollectModules.FeeCollectModule:
            return getPaidCollectModuleParams(feeCollectModule);
    }
    return undefined;
}
