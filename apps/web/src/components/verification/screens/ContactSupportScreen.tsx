'use client';

import React, { useEffect } from 'react';
import Image from 'next/image';
import shieldSvg from '@/assets/icons/shield.svg';
import liveDetectIdSvg from '@/assets/icons/live-detect-id.svg';
import ExitConfirmDialog from '../ExitConfirmDialog';
import { useEnrollFlow } from '@/context/EnrollFlowContext';

export default function ContactSupportScreen({ onExit }: { onExit: () => void }) {
    const { idDocument } = useEnrollFlow();
    const isPassport = (idDocument?.idType ?? '').toLowerCase().includes('passport');
    const [showExitDialog, setShowExitDialog] = React.useState(false);
    const fields = [
        { label: 'ID Type', value: idDocument?.idName || idDocument?.idType || '—' },
        { label: 'Country', value: idDocument?.country || '—' },
        { label: 'Name', value: idDocument?.name || '—' },
        {
            label: isPassport ? 'Passport Number' : 'National Number',
            value: idDocument?.nationalNumber || idDocument?.documentNumber || '—',
        },
        { label: 'Birthday', value: idDocument?.birthday || '—' },
    ];

    useEffect(() => {
        console.log(`idDocument: ${idDocument}`);
    }, [idDocument]);
    return (
        <div className="flex flex-col h-full bg-white px-xd-20">
            <ExitConfirmDialog
                open={showExitDialog}
                onCancel={() => setShowExitDialog(false)}
                onConfirm={() => onExit()}
            />

            {/* Close button */}
            <div className="flex absolute top-xd-50 right-xd-30 justify-end mb-2">
                <button
                    onClick={() => setShowExitDialog(true)}
                    className="text-red-400 hover:text-red-600"
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path
                            d="M5 5L15 15M15 5L5 15"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            </div>

            {/* Header */}
            <h1 className="text-xd-30 font-bold text-center text-[#1D1D1D] mb-xd-5  mt-xd-100">
                Identity Verification !
            </h1>
            <div className="flex items-center justify-center gap-2 mb-xd-11">
                <Image
                    src={liveDetectIdSvg}
                    alt="live detect ID"
                    className="object-contain w-xd-20 h-xd-20"
                />
                <span className="text-xd-16 font-medium text-[#1D1D1D]">
                    Live Detection Your ID
                </span>
            </div>
            {isPassport ? (
                <div className="flex justify-center mb-4">
                    <div className="text-center">
                        <p className="text-xd-12 text-[#8D8D8D] mb-xd-4">Passport</p>
                        <div className="w-xd-193 h-xd-109 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                            {idDocument?.frontImageData ? (
                                <img
                                    src={idDocument.frontImageData}
                                    alt="Passport"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full bg-gray-200" />
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="flex gap-xd-5 mb-4">
                    <div className=" w-xd-193 h-xd-109 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                        {idDocument?.frontImageData ? (
                            <img
                                src={idDocument.frontImageData}
                                alt="Front ID"
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <div className="w-full h-full bg-gray-200" />
                        )}
                    </div>
                    <div className=" w-xd-193 h-xd-109 rounded-xd-15 overflow-hidden bg-gray-100 border border-gray-100">
                        {idDocument?.backImageData ? (
                            <img
                                src={idDocument.backImageData}
                                alt="Back ID"
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <div className="w-full h-full bg-gray-200" />
                        )}
                    </div>
                </div>
            )}
            {/* Information Detected heading */}
            <div className="flex justify-center items-center gap-2 mb-4">
                <Image
                    src={liveDetectIdSvg}
                    alt="information detected"
                    className="object-contain shrink-0 w-xd-20 h-xd-20"
                />
                <span className="text-xd-16 font-medium text-[#1D1D1D]">Information Detected</span>
            </div>

            {/* Fields */}
            <div className="flex flex-col gap-xd-5 mb-4">
                {fields.map(({ label, value }) => (
                    <div
                        key={label}
                        className="h-xd-55 w-xd-390 bg-[#FCFCFC] p-xd-10 rounded-xd-15"
                    >
                        <p className="text-xd-12 text-[#8D8D8D] pb-xd-3">{label}</p>
                        <p className="text-xd-14 text-[#1D1D1D]">{value}</p>
                    </div>
                ))}
            </div>
            <div className="mt-auto mb-xd-35 flex items-center flex-col justify-end">
                {/* Privacy badge */}
                <div className="flex items-center flex-col justify-center gap-2 mb-xd-12">
                    <Image
                        src={shieldSvg}
                        alt="shield"
                        className="w-xd-15 h-xd-15 object-contain"
                    />
                    <span className="text-xd-12 text-[#388CFF]">
                        Your Privacy Is Completely Safe
                    </span>
                </div>

                {/* CTAs */}
                <button
                    disabled={true}
                    className="mb-xd-30 w-xd-390 h-xd-60 bg-[#FCFCFC] py-4 rounded-xd-20  text-[#1D1D1D] text-xd-16 font-medium"
                >
                    Will Contact With You Soon
                </button>
                <button disabled={true} className="w-full text-center text-sm text-[#388CFF] mb-2">
                    Within 2 Hour
                </button>
            </div>
        </div>
    );
}
