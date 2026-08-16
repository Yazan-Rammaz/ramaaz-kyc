'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ExitConfirmDialogProps {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ExitConfirmDialog({ open, onConfirm, onCancel }: ExitConfirmDialogProps) {
    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    className="fixed inset-0 z-50 flex items-center justify-center px-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    {/* Backdrop */}
                    <div className="absolute inset-0 bg-black/40" onClick={onCancel} />

                    {/* Dialog */}
                    <motion.div
                        className="relative bg-white rounded-2xl p-6 w-full max-w-xs shadow-xl"
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.9, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                    >
                        <h3 className="text-base font-semibold text-gray-900 text-center mb-2">
                            Exit Verification?
                        </h3>
                        <p className="text-xs text-gray-500 text-center mb-6">
                            Your progress will be lost. You can restart verification later from the
                            limited version.
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={onCancel}
                                className="flex-1 py-3 rounded-full border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                                Stay
                            </button>
                            <button
                                onClick={onConfirm}
                                className="flex-1 py-3 rounded-full bg-red-500 text-sm font-medium text-white hover:bg-red-600 transition-colors"
                            >
                                Exit
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
