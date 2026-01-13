export type PaymentStatus = "pending" | "paid";

export type Payment = {
    id: string,
    amount: number,
    status: PaymentStatus,
};

export type Currency = "CLP" | "USD" | "MXN";

export type Invoice = {
    id: string,
    amount: number,
    organization_id: string,
    currency: Currency,
    type: "received",
    payments: Array<Payment>,
};

export type CreditNote = {
    id: string,
    amount: number,
    currency: Currency,
    organization_id: string,
    type: "credit_note",
    reference: string,
};

export type Invoices = Array<Invoice | CreditNote>;

export type OrganizationSettings = {
    organization_id: string,
    currency: Currency,
};

export type GetInvoicesError = {
    type: "GetInvoicesError",
    message: string,
};

export type GetOrganizationSettingsError = {
    type: "GetOrganizationSettingsError",
    message: string,
};

export type PostPayPaymentError = {
    type: "PostPayPaymentError",
    message: string,
};

export type PayPayment = {
    status: string,
}
