'use client';

import React, { useEffect } from 'react';
import Image from 'next/image';
import { useEnrollFlow } from '@/context/EnrollFlowContext';
import verifiedBigSvg from '@/assets/icons/verified-big.svg';

/**
 * Terminal success screen, then hand back to the consumer app.
 *
 * rdb's version did considerably more: it PATCHed the verified name onto the
 * user's profile, optimistically flipped their in-memory auth state to VERIFIED,
 * and scheduled a refresh to reconcile with the backend.
 *
 * None of that belongs here. This service verifies identity and reports the
 * outcome; it must not write to a consumer's user records. Two reasons:
 *
 *   1. It would need write access to every consumer's profile API, so a bug in
 *      one tenant's flow could corrupt another's account data.
 *   2. Each consumer models users differently — rdb has firstName/lastName and a
 *      kycVerification badge; the next one will not.
 *
 * The consumer learns the outcome from the redirect, confirms it with NestJS,
 * and updates its own records however it likes.
 */
export default function SuccessScreen({ onDone }: { onDone: () => void }) {
    const { idDocument } = useEnrollFlow();

    // The verified person's name comes from the document — `name`, never
    // `idName`, which carries the document-type label ("Passport").
    const userName = idDocument?.name?.trim();

    // Auto-return so a user who walks away is not stranded on the KYC origin.
    useEffect(() => {
        const timer = setTimeout(onDone, 5000);
        return () => clearTimeout(timer);
    }, [onDone]);

    return (
        <div
            className="flex flex-col h-full bg-white items-center justify-center px-6 py-8 cursor-pointer"
            onClick={onDone}
        >
            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D]">
                Success Verification !
            </h1>
            <p className="text-xd-16 font-medium text-center text-[#1D1D1D] mb-xd-33 mt-xd-11">
                You Have Enjoy With Our Full Access
            </p>

            {/* Blue rosette verification badge */}
            <div className="mb-xd-20">
                <Image
                    src={verifiedBigSvg}
                    alt="verified"
                    className="object-contain w-xd-150 h-xd-150"
                />
            </div>

            {userName && <p className="text-xd-18 font-medium text-[#1D1D1D]">{userName}</p>}
        </div>
    );
}
