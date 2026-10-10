declare class ModalState {
    #private;
    get layer(): number;
    incrementLayer(): number;
    decrementLayer(): number;
}
export declare const modalState: ModalState;
export declare const isModalOpen: () => boolean;
export {};
