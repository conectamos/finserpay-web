import type { Metadata } from "next";
import IphoneEnrollmentPortal from "./iphone-enrollment-portal";

export const metadata: Metadata = {
  title: "Enrolamiento iPhone | FINSER PAY",
  description:
    "Modulo operativo para validar el enrolamiento de solicitudes iPhone.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function IphoneEnrollmentPage() {
  return <IphoneEnrollmentPortal />;
}
