import React, { createContext, useContext, useState, useEffect } from 'react';
import { useHotkeys } from '@mantine/hooks';

interface AccessibilityContextType {
    highContrast: boolean;
    toggleHighContrast: () => void;
    fontSize: number;
    increaseFontSize: () => void;
    decreaseFontSize: () => void;
    focusMode: boolean;
    toggleFocusMode: () => void;
    announceMessage: (message: string) => void;
}

const AccessibilityContext = createContext<AccessibilityContextType>(null);

export const useAccessibility = () => {
    const context = useContext(AccessibilityContext);
    if (!context) {
        throw new Error('useAccessibility must be used within AccessibilityProvider');
    }
    return context;
};

interface AccessibilityProviderProps {
    children: React.ReactNode;
}

export const AccessibilityProvider: React.FC<AccessibilityProviderProps> = ({ 
    children 
}) => {
    const [highContrast, setHighContrast] = useState(false);
    const [fontSize, setFontSize] = useState(16);
    const [focusMode, setFocusMode] = useState(false);
    const [announcement, setAnnouncement] = useState('');

    useEffect(() => {
        document.documentElement.style.fontSize = `${fontSize}px`;
        document.documentElement.classList.toggle('high-contrast', highContrast);
        document.documentElement.classList.toggle('focus-mode', focusMode);
    }, [fontSize, highContrast, focusMode]);

    useHotkeys([
        ['mod+j', () => toggleHighContrast()],
        ['mod+plus', () => increaseFontSize()],
        ['mod+minus', () => decreaseFontSize()],
        ['mod+f', () => toggleFocusMode()]
    ]);

    const toggleHighContrast = () => setHighContrast(prev => !prev);
    const increaseFontSize = () => setFontSize(prev => Math.min(prev + 2, 24));
    const decreaseFontSize = () => setFontSize(prev => Math.max(prev - 2, 12));
    const toggleFocusMode = () => setFocusMode(prev => !prev);

    const announceMessage = (message: string) => {
        setAnnouncement(message);
        setTimeout(() => setAnnouncement(''), 1000);
    };

    return (
        <AccessibilityContext.Provider
            value={{
                highContrast,
                toggleHighContrast,
                fontSize,
                increaseFontSize,
                decreaseFontSize,
                focusMode,
                toggleFocusMode,
                announceMessage
            }}
        >
            {children}
            <div
                role="alert"
                aria-live="polite"
                className="sr-only"
            >
                {announcement}
            </div>
        </AccessibilityContext.Provider>
    );
};
