<script lang="ts">
    import {
        $createParagraphNode as createParagraphNode,
        $getRoot as getRoot,
        $getSelection as getSelection,
        $isRangeSelection as isRangeSelection,
        createEditor,
        LineBreakNode,
        ParagraphNode,
        TextNode,
        COMMAND_PRIORITY_CRITICAL,
        COMMAND_PRIORITY_NORMAL,
        FORMAT_TEXT_COMMAND,
        KEY_MODIFIER_COMMAND,
        REDO_COMMAND,
        SELECTION_CHANGE_COMMAND,
        UNDO_COMMAND,
        KEY_ENTER_COMMAND,
        KEY_ESCAPE_COMMAND,
        type CreateEditorArgs,
        type GridSelection,
        type LexicalEditor,
        type NodeSelection,
        type RangeSelection,
        type EditorState,
    } from 'lexical';
    import {
        $convertFromMarkdownString as convertFromMarkdownString,
        $convertToMarkdownString as convertToMarkdownString,
        registerMarkdownShortcuts,
        CODE,
        QUOTE,
        TEXT_FORMAT_TRANSFORMERS,
        TEXT_MATCH_TRANSFORMERS,
    } from '@lexical/markdown';
    import { $createQuoteNode as createQuoteNode, QuoteNode, registerRichText } from '@lexical/rich-text';
    import { AutoLinkNode, LinkNode } from '@lexical/link';
    import { CodeNode } from '@lexical/code';
    import { $setBlocksType as setBlocksType } from '@lexical/selection';
    import { createEmptyHistoryState, registerHistory } from '@lexical/history';
    import { $canShowPlaceholder as canShowPlaceholder } from '@lexical/text';
    import type { TextFormatType } from 'lexical/nodes/LexicalTextNode';

    import { onMount } from 'svelte';

    import type { Writable } from 'svelte/store';
    import type { Action } from 'svelte/action';

    import Tribute, { type TributeItem } from 'tributejs';

    import FloatingEditorToolbar from '../../lib/editor/components/FloatingEditorToolbar.svelte';
    import FloatingLinkEditor from '../../lib/editor/components/FloatingLinkEditor.svelte';
    import { isSelectionLinkNode, isSelectionQuoteNode, isTextFormatType } from '../../lib/utils/lexical-utils';
    import LexicalTheme from '../../lib/editor/LexicalTheme';
    import { searchHandles } from '../../lib/user/search-handles';
    import { buildTributeUsernameMenuTemplate } from '../../lib/user/tribute-username-template';
    import { registerAutoLink } from '../../lib/editor/LexicalAutoLinkPlugin';
    import { HashtagNode } from '../../lib/editor/HashtagNode';
    import { registerHashtagPlugin } from '../../lib/editor/LexicalHashtagPlugin';
    import { createMentionNode, MENTION, MentionNode } from '../../lib/editor/MentionNode';
    import { registerMentionPlugin } from '../../lib/editor/LexicalMentionPlugin';
    import { registerEmojiShortcodePlugin } from '../../lib/editor/LexicalEmojiShortcodePlugin';
    import { EmojiNode } from '../../lib/editor/EmojiNode';
    import type { SimpleProfile } from '../../lib/user/SimpleProfile';
    import { formatHandleV2toV1 } from '../../lib/utils/lens-utils';

    export let content: Writable<string | undefined>;
    export let disabled: boolean = false;
    export let isCompact: boolean;

    // noinspection JSUnusedGlobalSymbols
    export const insertAtSelection = (text: string) => {
        editor.update(() => {
            const selection = getSelection();
            if (isRangeSelection(selection)) {
                selection.insertText(text);
            } else if (!selection) {
                const root = getRoot();
                const paragraphNode = createParagraphNode();
                const textNode = new TextNode(text);
                paragraphNode.append(textNode);
                root.append(paragraphNode);
            }
        });
    };

    const config: CreateEditorArgs = {
        namespace: 'Focalize',
        theme: LexicalTheme,
        onError: console.error,
        nodes: [
            LineBreakNode,
            ParagraphNode,
            TextNode,
            LinkNode,
            QuoteNode,
            CodeNode,
            AutoLinkNode,
            HashtagNode,
            MentionNode,
            EmojiNode,
        ],
    };

    const MARKDOWN_TRANSFORMERS = [
        CODE,
        QUOTE,
        MENTION,
        ...TEXT_FORMAT_TRANSFORMERS,
        ...TEXT_MATCH_TRANSFORMERS
    ];

    let editor: LexicalEditor;
    let editorElement: HTMLDivElement;
    let toolbarVisible = false;
    let linkEditorVisible = false;
    let selectionAnchor: DOMRect | undefined;
    let editorSelection: RangeSelection | undefined | null;
    let selectedBlockType: string | undefined;
    let showPlaceholder = true;
    let tributeActive = false;

    const onCommand = (command: TextFormatType | string) => {
        editor.update(() => {
            const selection = getSelection();
            if (!selection || !isRangeSelection(selection)) {
                return;
            }

            if (isTextFormatType(command)) {
                editor.dispatchCommand(FORMAT_TEXT_COMMAND, command);
                return;
            }

            switch (command) {
                case 'quote':
                    if (isSelectionQuoteNode(selection)) {
                        setBlocksType(selection, () => createParagraphNode());
                    } else {
                        setBlocksType(selection, () => createQuoteNode());
                    }
                    break;

                case 'link':
                    linkEditorVisible = true;
                    toolbarVisible = false;
                    break;

                default:
                    throw new Error(`Unknown command: ${command}`);
            }

            editorSelection = selection;
        });
    };

    const onSelectionChange = (): boolean => {
        const selection: RangeSelection | NodeSelection | GridSelection | null = getSelection();

        const hideToolbarAndClearSelection = () => {
            toolbarVisible = false;
            editorSelection = undefined;
            selectedBlockType = undefined;
            linkEditorVisible = false;
        };

        if (!isRangeSelection(selection)) {
            hideToolbarAndClearSelection();
            return false;
        }

        editorSelection = selection;

        if (selection.isCollapsed()) {
            hideToolbarAndClearSelection();
        } else {
            const nativeSelection = window.getSelection();
            const activeElement = document.activeElement;
            if (nativeSelection?.anchorNode && nativeSelection?.focusNode && activeElement === editorElement) {
                const range = document.createRange();
                range.setStart(nativeSelection.anchorNode, nativeSelection.anchorOffset);
                range.setEnd(nativeSelection.focusNode, nativeSelection.focusOffset);
                const rects: DOMRectList = range.getClientRects();
                selectionAnchor = rects[rects.length - 1];

                if (isSelectionLinkNode(selection)) {
                    linkEditorVisible = true;
                    toolbarVisible = false;
                } else {
                    toolbarVisible = true;
                }
            }
        }

        if (isSelectionQuoteNode(selection)) {
            selectedBlockType = 'quote';
        } else if (isSelectionLinkNode(selection)) {
            selectedBlockType = 'link';
        } else {
            selectedBlockType = 'paragraph';
        }

        return false;
    };

    const clearEditor = () => {
        editor?.update(() => {
            const root = getRoot();
            const selection = getSelection();
            const paragraph = createParagraphNode();
            root?.clear();
            root?.append(paragraph);

            if (selection) {
                paragraph.select();
            }
        });
    };

    $: if ($content) {
        editor.update(() => {
            const markdown = convertToMarkdownString(MARKDOWN_TRANSFORMERS);
            if ($content && $content !== markdown) {
                convertFromMarkdownString($content, MARKDOWN_TRANSFORMERS);
            }
        });
    } else {
        clearEditor();
    }

    const registerHistoryKeyboardShortcuts = () => {
        editor.registerCommand(KEY_MODIFIER_COMMAND, (payload: KeyboardEvent) => {
            const event: KeyboardEvent = payload;
            const { code, ctrlKey, metaKey, shiftKey } = event;
            if (code === 'KeyZ' && (ctrlKey || metaKey)) {
                event.preventDefault();
                if (shiftKey) {
                    editor.dispatchCommand(REDO_COMMAND, undefined);
                } else {
                    editor.dispatchCommand(UNDO_COMMAND, undefined);
                }
            } else if (code === 'KeyY' && (ctrlKey || metaKey)) {
                event.preventDefault();
                editor.dispatchCommand(REDO_COMMAND, undefined);
            }
            return false;
        }, COMMAND_PRIORITY_NORMAL);
    };

    const tribute: Action = (node: HTMLElement) => {
        const plainTextTribute = new Tribute<SimpleProfile>({
            values: (text, cb) => searchHandles(text, isCompact ? 4 : 5, cb),
            menuItemTemplate: (item: TributeItem<SimpleProfile>) => buildTributeUsernameMenuTemplate(item),
            fillAttr: 'handle',
            lookup: 'handle',
            noMatchTemplate: () => '<span class="hidden"></span>',
        });

        plainTextTribute.attach(node);

        return {
            destroy() {
                plainTextTribute.detach(node);
            },
        };
    };

    const onTributeReplaced = (e: Event) => {
        const event = e as CustomEvent;
        const handle = event.detail.item.original.handle as string;
        editor.update(() => {
            const selection = getSelection();
            if (!selection || !isRangeSelection(selection)) {
                return;
            }

            const newNode = createMentionNode(`@${formatHandleV2toV1(handle)}`);
            selection.insertNodes([newNode]);
            newNode.select();
        });
    };

    const escapeOverride = (): boolean => {
        toolbarVisible = false;
        const selection = getSelection();
        return selection == null || !isRangeSelection(selection) || selection.isCollapsed();
    };

    const registerTextListener = (editor: LexicalEditor) => {
        editor.registerTextContentListener(() => {
            editor.getEditorState().read(() => {
                $content = convertToMarkdownString(MARKDOWN_TRANSFORMERS);
                showPlaceholder = canShowPlaceholder(editor.isComposing());
            });
        })
    };

    $: contentLength = $content?.length ?? 0;

    onMount(() => {
        editor = createEditor(config);

        editor.setRootElement(editorElement);
        editor.registerCommand(SELECTION_CHANGE_COMMAND, onSelectionChange, COMMAND_PRIORITY_CRITICAL);
        editor.registerCommand(KEY_ENTER_COMMAND, () => tributeActive, COMMAND_PRIORITY_CRITICAL);
        editor.registerCommand(KEY_ESCAPE_COMMAND, escapeOverride, COMMAND_PRIORITY_CRITICAL);
        registerAutoLink(editor);
        registerMarkdownShortcuts(editor, MARKDOWN_TRANSFORMERS);
        registerRichText(editor);
        registerHashtagPlugin(editor);
        registerHistory(editor, createEmptyHistoryState(), 1000);
        registerMentionPlugin(editor);
        registerEmojiShortcodePlugin(editor);
        registerHistoryKeyboardShortcuts();
        registerTextListener(editor);

        editorElement?.addEventListener('tribute-active-true', () => tributeActive = true);
        editorElement?.addEventListener('tribute-active-false', () => tributeActive = false);
        editorElement?.addEventListener('tribute-replaced', onTributeReplaced);
    });
</script>

<div class="w-full relative {contentLength > 560 ? 'text-lg' : 'text-xl'}">
    <div bind:this={editorElement}
         use:tribute
         class="text-editor {isCompact ? 'min-h-[8rem]' : 'min-h-[10rem]'}">
    </div>

    {#if showPlaceholder}
        <div class='absolute top-3 text-gray-400 dark:text-gray-500 pointer-events-none'>
            What's happening?
        </div>
    {/if}
</div>

<FloatingEditorToolbar
    isVisible={toolbarVisible}
    anchor={selectionAnchor}
    selection={editorSelection}
    blockType={selectedBlockType}
    on:command={(e) => onCommand(e.detail)} />

<FloatingLinkEditor
    {editor}
    isVisible={linkEditorVisible}
    anchor={selectionAnchor} />

<style global>
    .text-editor {
        @apply w-full bg-transparent pt-3
        overflow-hidden break-keep [overflow-wrap:anywhere]
        border-none resize-none focus:outline-none focus:ring-0 focus:border-none
    }

    .text-editor > * {
        margin-bottom: 1.75rem;
    }

    .compact .text-editor > * {
        margin-bottom: 1.25rem;
    }
</style>