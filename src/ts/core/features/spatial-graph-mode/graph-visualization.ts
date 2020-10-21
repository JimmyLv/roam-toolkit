import cytoscape, {NodeDataDefinition, NodeSingular} from 'cytoscape'
// @ts-ignore
import cola from 'cytoscape-cola'
import {assumeExists} from 'src/core/common/assert'
import {RoamPanel} from 'src/core/roam/panel/roam-panel'
import {PanelElement, PanelId} from 'src/core/roam/panel/roam-panel-utils'
import {minBy} from 'lodash'
import {injectStyle} from 'src/core/common/css'
import {delay} from 'src/core/common/async'
import {GraphModeSettings} from 'src/core/features/spatial-graph-mode/graph-mode-settings'

const GRAPH_MASK_ID = 'roam-toolkit-graph-mode--mask'
const GRAPH_MODE_CSS_ID = 'roam-toolkit-graph-mode'

const getDomViewport = (): HTMLElement => assumeExists(document.querySelector('.roam-body-main')) as HTMLElement
const unselectText = () => window.getSelection()?.removeAllRanges()

cytoscape.use(cola)

export class GraphVisualization {
    static instance: GraphVisualization | null
    cy: cytoscape.Core
    // Queue position updates into batches.
    // This prevents the layout thrashing when alternating between reading/writing
    // Node positions to the DOM
    // https://developers.google.com/web/fundamentals/performance/rendering/avoid-large-complex-layouts-and-layout-thrashing
    positionUpdates: Map<PanelElement, {left: string; top: string}>

    constructor(container: HTMLElement) {
        const color = GraphModeSettings.get('Node Color')
        const selectionColor = GraphModeSettings.get('Selection Color')
        this.cy = cytoscape({
            container,
            style: [
                {
                    selector: 'node',
                    css: {
                        shape: 'roundrectangle',
                        'background-color': color,
                    },
                },
                {
                    selector: 'edge',
                    css: {
                        'line-color': color,
                        'target-arrow-color': color,
                        'source-arrow-color': color,
                        'curve-style': 'bezier',
                        'target-arrow-shape': 'triangle',
                    },
                },
                {
                    selector: ':selected',
                    css: {
                        'background-color': selectionColor,
                        'line-color': selectionColor,
                        'target-arrow-color': selectionColor,
                        'source-arrow-color': selectionColor,
                    },
                },
            ],
        })
        const domViewport = getDomViewport()
        // TODO move dom manipulation outside, leave this class purely concerned with Cytoscape
        this.cy.on('viewport resize', () => {
            requestAnimationFrame(() => {
                domViewport.style.transform = `translate(${this.cy.pan().x}px, ${
                    this.cy.pan().y
                }px) scale(${this.cy.zoom()})`
            })
        })
        this.positionUpdates = new Map()
        this.cy.on('position', event => this.queuePositionUpdate(event.target))
        this.cy.on('render', () => this.flushPositionUpdates())
        this.cy.maxZoom(1)
        this.cy.minZoom(0.2)
    }

    private queuePositionUpdate(node: NodeSingular) {
        const panel = RoamPanel.getPanel(node.id())
        // Gracefully do nothing if the panel has already disappeared.
        // That way, we won't queue obsolete position updates
        // if we re-layout just before the node is removed.
        // (e.g. zooming into a block on daily notes)
        if (panel) {
            const position = assumeExists(node.position())
            this.positionUpdates.set(panel, {
                left: `${Math.round(position.x - panel.offsetWidth / 2)}px`,
                top: `${Math.round(position.y - panel.offsetHeight / 2) + 5}px`,
            })
        }
    }

    private flushPositionUpdates() {
        requestAnimationFrame(() => {
            this.positionUpdates.forEach(({left, top}, panel) => {
                panel.style.left = left
                panel.style.top = top
            })
            this.positionUpdates = new Map()
        })
    }

    addNode(toPanel: PanelId, fromPanel: PanelId | null = null) {
        let node = this.cy.getElementById(toPanel)
        if (node.length === 0) {
            node = this.cy.add({
                data: {
                    id: toPanel,
                },
            })

            if (fromPanel) {
                const fromNode = this.cy.getElementById(fromPanel)
                node.position({
                    // Grow the graph towards the right
                    x: fromNode.position().x + fromNode.width() + getNodeSpacing(),
                    // Tiny random offset prevents nodes from getting jammed if it spawns
                    // in the exact same location as another
                    y: fromNode.position().y + Math.random() * 10,
                })
            } else {
                node.position(this.cy.pan())
            }
        }

        if (
            // Don't add an edge if you're air-dropping into an orphan page (e.g. search)
            fromPanel &&
            // Don't attach edges back to self
            fromPanel !== toPanel &&
            // Don't attach redundant edges
            this.cy.$(`edge[source = "${fromPanel}"][target = "${toPanel}"]`).length === 0
        ) {
            this.cy.edges().unselect()
            this.cy
                .add({
                    data: {
                        source: fromPanel,
                        target: toPanel,
                    },
                })
                .select()
        }

        // bring attention to the newly selected node
        this.selectNode(node)
        this.cy.promiseOn('layoutstop').then(() => {
            const followBehavior = GraphModeSettings.get('Follow nodes on open (off/pan/panZoom)')
            if (followBehavior === 'pan' || followBehavior === 'panZoom') {
                this.panTo(toPanel, fromPanel, followBehavior, unselectText)
            }
            unselectText()
        })
    }

    replaceNodeNames(before: string, after: string) {
        if (before === after) {
            return
        }
        // Replace the main node itself
        this.renameNode(this.cy.getElementById(before), after)
        // Replace usages in complex pages
        this.cy.nodes().forEach(node => {
            if (node.id().includes(`[[${before}]]`)) {
                this.renameNode(node, node.id().replace(`[[${before}]]`, `[[${after}]]`))
            }
        })
    }

    renameNode(node: NodeSingular, name: string) {
        // node ids are immutable. We have to create a new one
        const newNode = this.cy.add({
            data: {
                id: name,
            },
        })
        newNode.position(node.position())
        newNode.style('width', node.style('width'))
        newNode.style('height', node.style('height'))
        node.connectedEdges(`[source = "${node.id()}"]`).forEach(edge => {
            this.cy.add({
                data: {
                    source: name,
                    target: edge.target().id(),
                },
            })
        })
        node.connectedEdges(`[target = "${node.id()}"]`).forEach(edge => {
            this.cy.add({
                data: {
                    source: edge.source().id(),
                    target: name,
                },
            })
        })
        node.remove()
    }

    panTo(toPanel: PanelId, fromPanel: PanelId | null = null, behavior: 'pan' | 'panZoom', handleComplete: () => void) {
        let nodesToFocus = this.cy.getElementById(toPanel)
        if (fromPanel) {
            nodesToFocus = nodesToFocus.union(this.cy.getElementById(fromPanel))
        }
        this.cy.stop(true, true) // stop the previous animation
        const panOptions =
            behavior === 'pan'
                ? {
                      center: {
                          eles: nodesToFocus,
                      },
                  }
                : {
                      fit: {
                          eles: nodesToFocus,
                          padding: 50,
                      },
                  }
        this.cy.animate({
            ...panOptions,
            easing: 'ease-out',
            duration: getAnimationDuration(),
            complete: handleComplete,
        })
    }

    removeNode(panel: PanelId) {
        this.cy.getElementById(panel).remove()
    }

    runLayout(firstRender: boolean = false) {
        this.cy.nodes().forEach(node => {
            const domNode = RoamPanel.getPanel(node.id())
            if (domNode) {
                node.style('width', domNode.offsetWidth + 10)
                node.style('height', domNode.offsetHeight + 20)
            }
        })
        this.cy
            .layout({
                name: 'cola',
                fit: false,
                // @ts-ignore randomize when laying out for the first time, to avoid seizures from all the nodes being jammed on the same space
                randomize: firstRender,
                // @ts-ignore
                animate: getLayoutDuration() > 0,
                // @ts-ignore
                maxSimulationTime: getLayoutDuration() || 1000,
                // @ts-ignore if maxSimulationTime is too low, the layout doesn't actually run
                nodeSpacing: getNodeSpacing,
            })
            .stop()
            .run()
    }

    resetPanelStyles() {
        // @ts-ignore .json() is just an object in the types
        const nodes = this.cy.json().elements.nodes
        if (nodes) {
            nodes.forEach((node: NodeDataDefinition) => {
                const panel = assumeExists(RoamPanel.getPanel(assumeExists(node.data.id)))
                panel.style.removeProperty('left')
                panel.style.removeProperty('top')
            })
        }
    }

    zoomBy(scale: number) {
        this.cy.zoom({
            level: this.cy.zoom() * scale,
            renderedPosition: {
                x: this.cy.width() / 2,
                y: this.cy.height() / 2,
            },
        })
    }

    zoomOutCompletely() {
        this.cy.fit(undefined, 50)
    }

    panBy(x: number, y: number) {
        this.cy.panBy({x, y})
    }

    selectNode(node: NodeSingular) {
        this.cy.edges().unselect()
        this.cy.nodes().unselect()
        node.select().edges().select()
    }

    dragSelectionBy(x: number, y: number) {
        const zoom = this.cy.zoom()
        this.cy.nodes(':selected').shift({x: x / zoom, y: y / zoom})
        this.panBy(-x, -y)
    }

    nodeInMiddleOfViewport(): NodeSingular {
        const viewport = this.cy.extent()
        const viewportMiddle = {
            x: viewport.x1 + viewport.w / 2,
            y: viewport.y1 + viewport.h / 2,
        }
        return assumeExists(
            minBy(
                this.cy.nodes().map(node => node),
                node => {
                    return distance(viewportMiddle, node.position())
                }
            )
        )
    }

    selectMiddleOfViewport() {
        const middleNode = this.nodeInMiddleOfViewport()
        this.selectNode(middleNode)
    }

    ensureNodeIsSelected() {
        if (this.cy.nodes(':selected').length === 0) {
            this.selectMiddleOfViewport()
        }
    }

    onSelectNode(handleSelect: (nodeId: PanelId) => void) {
        this.cy.on('select', () => {
            const node = this.cy.nodes(':selected').first()
            if (node.length > 0) {
                handleSelect(node.id())
            }
        })
    }

    destroy() {
        this.cy.destroy()
    }

    static async init() {
        if (!GraphVisualization.instance) {
            const graphElement = document.createElement('div')
            graphElement.id = GRAPH_MASK_ID
            document.body.prepend(graphElement)

            injectStyle(
                `
                #${GRAPH_MASK_ID} {
                    position: fixed;
                    left: 0;
                    right: 0;
                    top: 0;
                    bottom: 0;
                }
                :root {
                    --card-width: 550px;
                }

                /* REMOVE UI CRUFT */
                #right-sidebar {
                    background-color: transparent;
                }
                #right-sidebar > div:first-child, /* sidebar toggle */
                #buffer, /* help icon in the bottom right */
                .roam-toolkit--panel-dupe /* extra sidebar panels that match the main panel */ {
                    display: none !important;
                }
                /* remove horizontal dividers between sidebar pages */
                .sidebar-content > div > div {
                    border: none !important;
                }

                /* Make the whole app click-through-able, so we can pan/zoom Cytoscape */
                #app {
                    pointer-events: none;
                }
                /* But make the actual content itself clickable */
                .roam-sidebar-container, .roam-topbar, .roam-toolkit--panel {
                    pointer-events: auto;
                }

                /* The container that holds everything */
                .roam-main .roam-body-main {
                    /* match Cytoscape's zoom origin */
                    transform-origin: 0 0;
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                }
                .roam-center {
                    /* cancel position: static on the main panel */
                    position: initial;
                }
                .roam-center .roam-toolkit--panel {
                    /* cancel out margins that custom themes might add */
                    margin: 0 !important;
                }
                .roam-toolkit--panel {
                    /* min-width doesn't really work, it jams up against #roam-right-sidebar-content */
                    width: ${GraphModeSettings.get('Width')};
                    height: auto !important; /* prevent the main panel from stretching 100% */
                    min-height: ${GraphModeSettings.get('Min Height')};
                    max-height: ${GraphModeSettings.get('Max Height')};
                    border-radius: 5px;
                    position: absolute !important;
                    background: white;
                    overflow-y: scroll !important;
                    margin: 0 !important;
                }
                /* The innermost sidebar div plays best with custom themes */
                .sidebar-content .roam-toolkit--panel {
                    padding: 0 16px !important;
                }
                /* The innermost main div plays best with custom themes */
                .roam-center > div {
                    overflow: visible !important;
                }
                /* Indicate when a main panel's edges are anchored by a hidden sidebar*/
                .roam-toolkit--panel-anchored::before {
                    content: "⚓";
                    left: 6px;
                    top: 6px;
                    position: absolute;
                }
                `,
                GRAPH_MODE_CSS_ID
            )

            GraphVisualization.instance = new GraphVisualization(graphElement)
            // Wait for styles to finish applying, so panels have the right dimensions,
            // and cytoscape has fully instantiated
            await delay(300)
        }
    }

    static get(): GraphVisualization {
        return assumeExists(GraphVisualization.instance)
    }

    static destroy() {
        if (GraphVisualization.instance) {
            GraphVisualization.instance.resetPanelStyles()
            GraphVisualization.instance.destroy()
            const domViewport = getDomViewport()
            domViewport.style.width = '100vw'
            domViewport.style.height = 'calc(100% - 45px)'
            domViewport.style.removeProperty('transform')

            document.getElementById(GRAPH_MODE_CSS_ID)?.remove()
            document.getElementById(GRAPH_MASK_ID)?.remove()

            GraphVisualization.instance = null
        }
    }
}

const getAnimationDuration = (): number => Number.parseInt(GraphModeSettings.get('Animation Duration (ms)'), 10)
const getLayoutDuration = (): number => Number.parseInt(GraphModeSettings.get('Layout Duration (ms)'), 10)
const getNodeSpacing = (): number => Number.parseInt(GraphModeSettings.get('Node Spacing'), 10)

type Vector = {x: number; y: number}

const distance = (v1: Vector, v2: Vector) => Math.sqrt((v1.x - v2.x) ** 2 + (v1.y - v2.y) ** 2)
