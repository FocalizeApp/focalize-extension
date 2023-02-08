import {initEthers} from "./ethers-service";
import {getDefaultProfile} from "./lens-profile";

import type {Profile} from "../graph/lens-service";
import {getAccessToken} from "./lens-auth";

export type User = {
    address: string,
    profileId: string,
    handle: string,
    avatarUrl: string,
    canUseRelay: boolean
};

export enum UserError {
    WALLET_NOT_CONNECTED,
    NOT_AUTHENTICATED,
    NO_PROFILE,
    UNKNOWN
}

export const userFromProfile = (profile: Profile): User => {
    let avatarUrl;
    if (profile.picture?.__typename === "MediaSet") {
        avatarUrl = profile.picture?.original?.url;
    } else if (profile.picture?.__typename === "NftImage") {
        avatarUrl = profile.picture.uri;
    }

    return {
        address: profile.ownedBy,
        profileId: profile.id,
        handle: profile.handle,
        avatarUrl,
        canUseRelay: profile.dispatcher?.canUseRelay ?? false
    }
}

export const getCurrentUser = async (): Promise<{user?: User, error?: UserError}> => {
    let address: string, accessToken: string, profile: Profile;

    // First initiate the provider and get the address
    try {
        const accounts = await initEthers();
        address = accounts[0];
    } catch (e) {
        console.error('getCurrentUser: Error during wallet initialization', e);
        return { error: UserError.WALLET_NOT_CONNECTED };
    }

    if (!address) {
        return { error: UserError.WALLET_NOT_CONNECTED };
    }

    // Simply check for an existing access token as a signal that the user has logged in before
    // We don't need to know if it's valid right now
    try {
        accessToken = await getAccessToken()
    } catch (e) {
        return { error: UserError.NOT_AUTHENTICATED };
    }

    if (!accessToken) {
        console.log('getCurrentUser: No saved access token found, likely first session...');
        return { error: UserError.NOT_AUTHENTICATED };
    }

    try {
        profile = await getDefaultProfile(address);
    } catch (e) {
        console.error('getCurrentUser: unable to get default Lens profile', e)
        return { error: UserError.NO_PROFILE };
    }

    try {
        const user = userFromProfile(profile);
        return {user};
    } catch (e) {
        return {error: UserError.UNKNOWN};
    }
};