import axios from "axios";
import { 
    Invoices, 
    Invoice, 
    CreditNote, 
    OrganizationSettings,
    Currency,
    Payment,
    GetInvoicesError, 
    GetOrganizationSettingsError,
    PostPayPaymentError,
    PayPayment,
} from "./types";
import * as TE from "fp-ts/TaskEither"
import { pipe } from "fp-ts/function"
import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import * as S from "fp-ts/string"
import * as Sep from "fp-ts/lib/Separated";
import * as Ord from "fp-ts/Ord";
import * as N from "fp-ts/number";
import * as O from "fp-ts/Option";

const axiosClient = () => axios.create({
    baseURL: "https://recruiting.data.bemmbo.com",
})

const getInvoicesTE = () => TE.tryCatch<GetInvoicesError, Invoices>(
    async () => {
        const client = axiosClient();
        const response = await client.get("/invoices/pending");
        return response.data;
    },
    (e) => ({
        type: "GetInvoicesError" as const,
        message: (new Error(String(e))).message,
    }),
)

const getOrganizationSettingsTE = (organization_id: string) => TE.tryCatch<GetOrganizationSettingsError, OrganizationSettings>(
    async () => {
        const client = axiosClient();
        const response = await client.get(`/organization/${organization_id}/settings`);
        return response.data;
    },
    (e) => ({
        type: "GetOrganizationSettingsError" as const,
        message: (new Error(String(e))).message,
    }),
)

const getOrganizationsCurrencyArray = (uniqueOrganizationIds: string[]) => pipe(
    uniqueOrganizationIds,
    A.map((organization_id) => getOrganizationSettingsTE(organization_id)),
    A.sequence(TE.ApplicativePar),
)

const postPayPaymentTE = (payment_id: string, amount: number) => TE.tryCatch<PostPayPaymentError, PayPayment>(
    async () => {
        const client = axiosClient();
        const response = await client.post(`/payment/${payment_id}/pay`, { amount });
        return response.data;
    },
    (e) => ({
        type: "PostPayPaymentError" as const,
        message: (new Error(String(e))).message,
    }),
)

const payInvoicePayments = (payments: Payment[]) => pipe(
    payments,
    A.filter((payment) => payment.status === "pending"),
    A.map((payment) => postPayPaymentTE(payment.id, payment.amount)),
)

const payAllInvoices = (invoices: Invoice[]) => pipe(
    invoices,
    A.map((invoice) => payInvoicePayments(invoice.payments)),
    A.flatten,
    A.sequence(TE.ApplicativePar),
)

const isCreditNote = (x: Invoice | CreditNote): x is CreditNote => x.type === "credit_note";

const isInvoice = (x: Invoice | CreditNote): x is Invoice => x.type === "received";

const separateInvoicesData = (invoicesData: Invoices) => pipe(
    invoicesData,
    A.partition(isCreditNote),
    Sep.mapLeft(A.filter(isInvoice)),
)

const updateCreditNoteAmount = (creditNote: CreditNote, currency: Currency) => ({
    ...creditNote,
    currency,
    amount: convertAmount(creditNote.currency, currency, creditNote.amount),
})

const updateInvoiceAmounts = (invoice: Invoice, currency: Currency) => ({
    ...invoice,
    currency,
    amount: convertAmount(invoice.currency, currency, invoice.amount),
    payments: invoice.payments.map(
        (payment) => ({
            ...payment,
            amount: convertAmount(invoice.currency, currency, payment.amount),
        }),
    ),
})

const getUniqueOrganizationsIds = (invoices: Invoice[]) => pipe(
    invoices,
    A.map((invoice) => invoice.organization_id),
    A.uniq(S.Eq),
)

const getOrganizations = (organizationsSettings: OrganizationSettings[]) => pipe(
    organizationsSettings,
    A.map(({ organization_id, currency }) => [ organization_id, currency ] as const),
    Object.fromEntries,
)

const EXCHANGE_RATES: Record<string, number> = {
    "USD->CLP": 900,
    "CLP->USD": 1 / 900,
    "MXN->CLP": 60,
    "CLP->MXN": 1 / 60,
    "USD->MXN": 15,
    "MXN->USD": 1 / 15,
}

const convertAmount = (from: Currency, to: Currency, amount: number) => pipe(
    amount,
    O.fromPredicate(() => from === to),
    O.match(
        () => amount * EXCHANGE_RATES[`${from}->${to}`],
        () => amount,
    ),
)

const byAmount = pipe(
    N.Ord,
    Ord.contramap((payment: Payment) => payment.amount),
)

const sortInvoicePayments = (invoice: Invoice) => pipe(
    invoice.payments,
    A.sort(byAmount),
)

const sortAllInvoicesPayments = (invoices: Invoice[]) => pipe(
    invoices,
    A.map((invoice) => ({
        ...invoice,
        payments: sortInvoicePayments(invoice),

    })),
)

const byStatusPending = (payment: Payment) => payment.status === "pending";


const removePaidInvoicePayments = (invoice: Invoice) => pipe(
    invoice.payments,
    A.filter(byStatusPending),
)

const removeAllInvoicesPaidPayments = (invoices: Invoice[]) => pipe(
    invoices,
    A.map((invoice) => ({
        ...invoice,
        payments: removePaidInvoicePayments(invoice),
    })),
)

// REFACTORIZAR LÓGICA EN PIPES
const applyDiscountToPayments = (payments: Payment[], discount: number) => pipe(
    payments,
    A.reduce({ remainingDiscount: discount, updatedPayments: [] as Payment[] }, ({ remainingDiscount, updatedPayments }, payment) => {
        if (remainingDiscount === 0) return {
            remainingDiscount,
            updatedPayments: [ ...updatedPayments, payment ],
        }
        const discountToApply = Math.min(remainingDiscount, payment.amount);
        return {
            remainingDiscount: remainingDiscount - discountToApply,
            updatedPayments: [ ...updatedPayments, {
                ...payment,
                status: payment.amount - discountToApply === 0 ? "paid" : payment.status,
                amount: payment.amount - discountToApply,
            } ],
        };
    }),
    ({ updatedPayments }) => updatedPayments,
)

const selectInvoiceToApplyDiscount = (creditNote: CreditNote) => (invoice: Invoice) => pipe(
    invoice,
    O.fromPredicate((invoice) => invoice.id === creditNote.reference),
    O.map((invoice) => ({
        ...invoice,
        payments: applyDiscountToPayments(invoice.payments, creditNote.amount),
    })),
    O.getOrElse(() => invoice),
)

const applyCreditNoteToInvoices = (invoices: Invoice[], creditNote: CreditNote) => pipe(
    invoices,
    A.map(selectInvoiceToApplyDiscount(creditNote)),
)

const applyAllCreditNotes = (creditNotes: CreditNote[]) => (invoices: Invoice[]) => pipe(
    creditNotes,
    A.reduce(invoices, (updatedInvoices, creditNote) => applyCreditNoteToInvoices(updatedInvoices, creditNote)),
) 

const main = async () => {
    // OBTENER FACTURAS Y NOTAS DE CREDITO
    const invoicesData = await getInvoicesTE()();

    if(E.isLeft(invoicesData)){
        console.log("Error fetching invoices:", invoicesData.left);
        return;
    }

    const { left: invoices, right: creditNotes } = separateInvoicesData(invoicesData.right);

    // OBTENER CURRENCY PARA CADA ORGANIZACIÓN
    const uniqueOrganizationIds = getUniqueOrganizationsIds(invoices);
    const organizationsCurrency = await getOrganizationsCurrencyArray(uniqueOrganizationIds)();

    if(E.isLeft(organizationsCurrency)){
        console.log("Error building organizations currency array", organizationsCurrency);
        return;
    }

    const organizations = getOrganizations(organizationsCurrency.right);

    // HACER CONVERSIONES DE MONEDA PARA CADA MONTO
    const updatedCreditNotes = pipe(
        creditNotes,
        A.map((creditNote) => updateCreditNoteAmount(creditNote, organizations[creditNote.organization_id])),
    );

    const updatedInvoices = pipe(
        invoices,
        A.map((invoice) => updateInvoiceAmounts(invoice, organizations[invoice.organization_id]))
    );

    // ORDENAR PAYMENTS PARA CADA INVOICE
    const sortedInvoicesByPayments = pipe(
        updatedInvoices,
        sortAllInvoicesPayments,
    );

    // ELIMINAR PAYMENTS QUE NO ESTÉN PENDING
    const invoicesWithPendingPayments = pipe(
        sortedInvoicesByPayments,
        removeAllInvoicesPaidPayments,
    );

    // APLICAR CREDIT NOTES A LOS PAYMENTS
    const invoicesWithCreditNotesApplied = pipe(
        invoicesWithPendingPayments,
        applyAllCreditNotes(updatedCreditNotes),
    );

    // ELIMINAR PAYMENTS QUE NO ESTÉN PENDING
    const invoicesReady = pipe(
        invoicesWithCreditNotesApplied,
        removeAllInvoicesPaidPayments,
    );

    console.log("Notas de Credito:", JSON.stringify(updatedCreditNotes, null, 2));
    console.log("Facturas con Pagos Ordenados y por Pagar:", JSON.stringify(invoicesWithPendingPayments, null, 2));

    console.log("Facturas con Pagos con Descuento Aplicado:", JSON.stringify(invoicesReady, null, 2));

    const allInvoicesPaid = await payAllInvoices(invoicesReady)();

    if(E.isLeft(allInvoicesPaid)){
        console.log("Error paying invoices payments");
        return;
    }

    console.log("Todas las Facturas Pagadas:", JSON.stringify(allInvoicesPaid.right, null, 2));
}

main()
