import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("🧯 ErrorBoundary pegou um erro:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-red-700 bg-red-100">
          <h1 className="font-bold mb-2">Ocorreu um erro na tela</h1>
          <pre className="whitespace-pre-wrap text-sm">
            {String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

